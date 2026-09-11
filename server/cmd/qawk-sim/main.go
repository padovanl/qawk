// qawk-sim runs simulated devices that take updates -- as far as the server
// can tell -- for demonstrations and for testing fleets and the release
// pipeline with more devices than there are on the bench.
//
//	qawk-sim -url http://localhost:8080 -token <gateway token> \
//	         -fleet dev:20 -fleet beta:40 -fleet prod:120 -fleet expo:8
//
// Each device registers through the device API like a real one, with the
// gateway token, and reports attributes: device_type=neo-sim, sim=true and
// ring=<the name given with -fleet>, which is what a fleet's rule can match
// (attribute.ring==beta). When it is given a deployment it says it is
// downloading, then installing, then that it is done -- after a random time
// between -install-min and -install-max -- without downloading anything. A
// deployment it is told to skip outside its maintenance window is answered as
// SWUpdate answers it ("closed, success: Skipped Update.") and then waited for;
// a download-only one is reported downloaded. A
// deployment whose module name or version contains one of -fail (a
// comma-separated list; "broken" by default) fails, as does a random share
// -fail-rate of the others; a device that fails says it rolled back.
//
// With -system name:count:component=n,... it runs systems instead -- a
// bowling centre of lane computers and the terminals attached to them:
//
//	qawk-sim -token <t> -system center:16:st05=2,hyper=1,hd=6
//
// makes 16 systems, center-01 to center-16, each of 2 st05, 1 hyper and 6 hd;
// every device reports device_type=<component> and center=<its system>, which
// a system type matches (attribute.device_type==hd, key attribute.center).
// -fail-where center=center-03,device_type=hyper makes the devices with those
// attributes fail whatever they are given (repeatable); with set=2.0 among
// them, only what names 2.0 -- a module name or version containing it.
//
// It runs until interrupted, or for -duration, and prints what the devices
// did every ten seconds.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type fleetSpec struct {
	name string
	n    int
}

type specs []fleetSpec

func (s *specs) String() string { return fmt.Sprint(*s) }

func (s *specs) Set(v string) error {
	name, count, ok := strings.Cut(v, ":")
	n, err := strconv.Atoi(count)
	if !ok || err != nil || n < 1 || name == "" {
		return fmt.Errorf("-fleet takes name:count, such as beta:40")
	}
	*s = append(*s, fleetSpec{name, n})
	return nil
}

// sysSpec is a kind of system to simulate: name:count:component=n,...
type sysSpec struct {
	name  string
	count int
	comps [][2]string // component, how many
}

type sysSpecs []sysSpec

func (s *sysSpecs) String() string { return fmt.Sprint(*s) }

func (s *sysSpecs) Set(v string) error {
	parts := strings.SplitN(v, ":", 3)
	if len(parts) != 3 {
		return fmt.Errorf("-system takes name:count:component=n,..., such as center:16:st05=2,hyper=1,hd=6")
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil || n < 1 {
		return fmt.Errorf("-system: %q is not a count", parts[1])
	}
	sp := sysSpec{name: parts[0], count: n}
	for _, c := range strings.Split(parts[2], ",") {
		k, m, ok := strings.Cut(c, "=")
		if _, err := strconv.Atoi(m); !ok || err != nil || k == "" {
			return fmt.Errorf("-system: %q is not component=n", c)
		}
		sp.comps = append(sp.comps, [2]string{k, m})
	}
	*s = append(*s, sp)
	return nil
}

type counters struct {
	polls, errors, installing, succeeded, failed, canceled atomic.Int64
}

type sim struct {
	client     *http.Client
	base       string
	token      string
	installMin time.Duration
	installMax time.Duration
	fail       []string
	failRate   float64
	c          counters
}

type device struct {
	id, ring string
	s        *sim
	attrs    map[string]string // reported besides the usual ones
	doomed   bool              // fails whatever it is given (-fail-where)
	failOn   []string          // fails what names one of these (-fail-where ...,set=)
	busy     atomic.Bool
	told     atomic.Bool // has sent its attributes
	done     sync.Map    // deployment ids already answered
}

func (d *device) req(ctx context.Context, method, url, body string) (int, []byte) {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return 0, nil
	}
	req.Header.Set("Authorization", "GatewayToken "+d.s.token)
	req.Header.Set("Accept", "application/hal+json")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := d.s.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			d.s.c.errors.Add(1)
		}
		return 0, nil
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		d.s.c.errors.Add(1)
	}
	return resp.StatusCode, b
}

type links map[string]struct {
	Href string `json:"href"`
}

func (d *device) poll(ctx context.Context) {
	root := d.s.base + "/" + d.id
	code, body := d.req(ctx, "GET", root, "")
	d.s.c.polls.Add(1)
	if code != 200 {
		return
	}
	var r struct {
		Links links `json:"_links"`
	}
	if json.Unmarshal(body, &r) != nil {
		return
	}
	// As SWUpdate does: the attributes go on the first contact whether or not
	// the server asks -- hawkBit does not ask a device that registered itself
	// -- and again whenever it does.
	if _, ok := r.Links["configData"]; ok || !d.told.Load() {
		data := map[string]string{"device_type": "neo-sim", "sim": "true", "os_version": "25.7.2", "slot": "A"}
		if d.ring != "" {
			data["ring"] = d.ring
		}
		for k, v := range d.attrs {
			data[k] = v
		}
		attrs, _ := json.Marshal(map[string]any{"mode": "merge", "data": data})
		if code, _ := d.req(ctx, "PUT", root+"/configData", string(attrs)); code/100 == 2 {
			d.told.Store(true)
		}
	}
	if l, ok := r.Links["deploymentBase"]; ok && !d.busy.Load() {
		d.deploy(ctx, root, l.Href)
	}
	if l, ok := r.Links["cancelAction"]; ok {
		parts := strings.Split(l.Href, "/")
		id := parts[len(parts)-1]
		d.req(ctx, "POST", root+"/cancelAction/"+id+"/feedback",
			`{"status":{"execution":"closed","result":{"finished":"success"},"details":["qawk-sim: canceled"]}}`)
		d.s.c.canceled.Add(1)
	}
}

func (d *device) deploy(ctx context.Context, root, href string) {
	code, body := d.req(ctx, "GET", href, "")
	if code != 200 {
		return
	}
	var dep struct {
		ID         string `json:"id"`
		Deployment struct {
			Update string `json:"update"`
			Window string `json:"maintenanceWindow"`
			Chunks []struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"chunks"`
		} `json:"deployment"`
	}
	if json.Unmarshal(body, &dep) != nil || dep.ID == "" {
		return
	}
	if _, seen := d.done.Load(dep.ID); seen {
		return
	}
	if dep.Deployment.Update == "skip" {
		if dep.Deployment.Window != "" {
			// outside its maintenance window. SWUpdate answers this with
			// "closed, success: Skipped Update." -- which, taken at its word,
			// marks a device updated that is not; the simulated devices say
			// the same, so the server's handling of it is exercised. Once per
			// deployment link: the link changes when the window opens.
			if _, said := d.done.LoadOrStore("skip:"+href, true); !said {
				d.req(ctx, "POST", root+"/deploymentBase/"+dep.ID+"/feedback",
					`{"status":{"execution":"closed","result":{"finished":"success"},"details":["Skipped Update."]}}`)
			}
			return
		}
		// download only: nothing to install; it says it has downloaded
		d.done.Store(dep.ID, true)
		d.req(ctx, "POST", root+"/deploymentBase/"+dep.ID+"/feedback",
			`{"status":{"execution":"downloaded","result":{"finished":"none"},"details":["qawk-sim: downloaded, not installed"]}}`)
		return
	}
	var what []string
	for _, c := range dep.Deployment.Chunks {
		what = append(what, c.Name+" "+c.Version)
	}
	d.busy.Store(true)
	go d.install(ctx, root, dep.ID, strings.Join(what, " + "))
}

func (d *device) install(ctx context.Context, root, id, what string) {
	defer d.busy.Store(false)
	fb := root + "/deploymentBase/" + id + "/feedback"
	send := func(exec, finished, detail string) int {
		b, _ := json.Marshal(map[string]any{"status": map[string]any{"execution": exec,
			"result": map[string]string{"finished": finished}, "details": []string{"qawk-sim: " + detail}}})
		code, _ := d.req(ctx, "POST", fb, string(b))
		return code
	}
	d.s.c.installing.Add(1)
	defer d.s.c.installing.Add(-1)
	total := d.s.installMin
	if span := d.s.installMax - d.s.installMin; span > 0 {
		total += time.Duration(rand.Int63n(int64(span)))
	}
	send("proceeding", "none", "downloading "+what)
	if !sleep(ctx, total*2/5) {
		return
	}
	send("proceeding", "none", "installing "+what)
	if !sleep(ctx, total*3/5) {
		return
	}
	fail := d.doomed || rand.Float64() < d.s.failRate
	for _, m := range d.failOn {
		fail = fail || strings.Contains(what, m)
	}
	for _, m := range d.s.fail {
		if m != "" && strings.Contains(what, m) {
			fail = true
		}
	}
	var code int
	if fail {
		code = send("closed", "failure", what+" did not start: rolled back to the previous version")
		d.s.c.failed.Add(1)
	} else {
		code = send("closed", "success", what+" installed")
		d.s.c.succeeded.Add(1)
	}
	// A report the server did not take is made again at the next poll, as a
	// real device does: marked done, the action stayed open for ever.
	if code/100 == 2 || code == http.StatusGone {
		d.done.Store(id, true)
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func main() {
	var fleets specs
	var systems sysSpecs
	var failWhere []map[string]string
	url := flag.String("url", "http://localhost:8080", "server")
	tenant := flag.String("tenant", "DEFAULT", "tenant")
	token := flag.String("token", os.Getenv("QAWK_GATEWAY_TOKEN"), "gateway token")
	flag.Var(&fleets, "fleet", "name:count -- that many devices with ring=name (repeatable)")
	flag.Var(&systems, "system", "name:count:component=n,... -- that many systems of those components (repeatable)")
	flag.Func("fail-where", "key=value,... -- devices with those attributes fail everything (repeatable)", func(v string) error {
		m := map[string]string{}
		for _, kv := range strings.Split(v, ",") {
			k, val, ok := strings.Cut(kv, "=")
			if !ok {
				return fmt.Errorf("-fail-where takes key=value,...")
			}
			m[k] = val
		}
		failWhere = append(failWhere, m)
		return nil
	})
	prefix := flag.String("prefix", "sim", "controller ids are <prefix>-<fleet>-<n>")
	interval := flag.Duration("interval", 10*time.Second, "polling interval of each device")
	installMin := flag.Duration("install-min", 5*time.Second, "shortest pretend installation")
	installMax := flag.Duration("install-max", 20*time.Second, "longest pretend installation")
	fail := flag.String("fail", "broken", "deployments whose module name or version contains one of these fail (comma-separated)")
	failRate := flag.Float64("fail-rate", 0, "share of the other deployments that fail (0 to 1)")
	duration := flag.Duration("duration", 0, "how long to run (0: until interrupted)")
	flag.Parse()
	if *token == "" || (len(fleets) == 0 && len(systems) == 0) {
		fmt.Fprintln(os.Stderr, "usage: qawk-sim -token <gateway token> -fleet name:count [-fleet ...] | -system name:count:component=n,...")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *duration)
		defer cancel()
	}

	var devices []*device
	for _, f := range fleets {
		for i := 1; i <= f.n; i++ {
			devices = append(devices, &device{id: fmt.Sprintf("%s-%s-%03d", *prefix, f.name, i), ring: f.name})
		}
	}
	for _, sp := range systems {
		for c := 1; c <= sp.count; c++ {
			key := fmt.Sprintf("%s-%02d", sp.name, c)
			for _, comp := range sp.comps {
				n, _ := strconv.Atoi(comp[1])
				for i := 1; i <= n; i++ {
					d := &device{id: fmt.Sprintf("%s-%s-%s-%d", *prefix, key, comp[0], i),
						attrs: map[string]string{"device_type": comp[0], sp.name: key}}
					for _, w := range failWhere {
						match := true
						for k, v := range w {
							if k != "set" && d.attrs[k] != v {
								match = false
							}
						}
						switch {
						case !match:
						case w["set"] != "":
							d.failOn = append(d.failOn, w["set"])
						default:
							d.doomed = true
						}
					}
					devices = append(devices, d)
				}
			}
		}
	}
	total := len(devices)
	s := &sim{
		client: &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
			MaxIdleConns: total, MaxIdleConnsPerHost: total, IdleConnTimeout: 90 * time.Second}},
		base:  strings.TrimRight(*url, "/") + "/" + *tenant + "/controller/v1",
		token: *token, installMin: *installMin, installMax: *installMax,
		fail: strings.Split(*fail, ","), failRate: *failRate,
	}
	fmt.Printf("qawk-sim: %d devices (%s %s) on %s, polling every %v\n", total, fleets.String(), systems.String(), *url, *interval)

	var wg sync.WaitGroup
	for _, d := range devices {
		d.s = s
		start := time.Duration(rand.Int63n(int64(*interval) + 1))
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !sleep(ctx, start) {
				return
			}
			for {
				d.poll(ctx)
				jitter := time.Duration(rand.Int63n(int64(*interval)/5 + 1))
				if !sleep(ctx, *interval-*interval/10+jitter) {
					return
				}
			}
		}()
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	begin := time.Now()
	for {
		select {
		case <-done:
			fmt.Printf("qawk-sim: stopped after %v\n", time.Since(begin).Round(time.Second))
			return
		case <-t.C:
			fmt.Printf("%5.0fs  polls %d  installing %d  installed %d  failed %d  canceled %d  errors %d\n",
				time.Since(begin).Seconds(), s.c.polls.Load(), s.c.installing.Load(), s.c.succeeded.Load(),
				s.c.failed.Load(), s.c.canceled.Load(), s.c.errors.Load())
		}
	}
}
