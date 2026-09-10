// qawk-load simulates a fleet of devices polling an update server, and says
// how the server held up.
//
//	go run ./cmd/qawk-load -url http://localhost:8080 -token <gateway token> -devices 10000
//
// Every simulated device does what SWUpdate does: it polls its root resource
// at a fixed interval with the gateway token, sends its config data when the
// server asks for it, and -- with -act -- reads a deployment it is given and
// reports it installed. The devices start spread over the ramp, not all in the
// same second, as a real fleet does.
//
// It works against Qawk and against hawkBit alike; the numbers of the two are
// directly comparable. Every ten seconds, and at the end, it prints the rate,
// the errors by status code and the latency percentiles.
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
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type stats struct {
	mu        sync.Mutex
	latencies []time.Duration
	codes     map[string]int
	requests  atomic.Int64
}

func (s *stats) add(kind string, code int, d time.Duration, err error) {
	s.requests.Add(1)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latencies = append(s.latencies, d)
	key := fmt.Sprintf("%s %d", kind, code)
	if err != nil {
		key = kind + " " + shortErr(err)
	}
	s.codes[key]++
}

func shortErr(err error) string {
	e := err.Error()
	if i := strings.LastIndex(e, ": "); i >= 0 {
		e = e[i+2:]
	}
	return e
}

// take returns what was gathered since the last call, and resets it.
func (s *stats) take() ([]time.Duration, map[string]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, c := s.latencies, s.codes
	s.latencies, s.codes = nil, map[string]int{}
	return l, c
}

func pct(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1) * p)
	return sorted[i]
}

func report(label string, l []time.Duration, codes map[string]int, secs float64) {
	sort.Slice(l, func(i, j int) bool { return l[i] < l[j] })
	keys := make([]string, 0, len(codes))
	for k := range codes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, codes[k]))
	}
	fmt.Printf("%-8s %7.1f req/s  p50 %-7v p90 %-7v p99 %-7v max %-7v  %s\n", label, float64(len(l))/secs,
		pct(l, .5).Round(time.Millisecond), pct(l, .9).Round(time.Millisecond), pct(l, .99).Round(time.Millisecond),
		pct(l, 1).Round(time.Millisecond), strings.Join(parts, " "))
}

type device struct {
	id     string
	client *http.Client
	base   string
	token  string
	act    bool
	st     *stats
}

func (d *device) do(ctx context.Context, kind, method, url string, body string) (int, []byte) {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequestWithContext(ctx, method, url, rd)
	req.Header.Set("Authorization", "GatewayToken "+d.token)
	req.Header.Set("Accept", "application/hal+json")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	start := time.Now()
	resp, err := d.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			d.st.add(kind, 0, time.Since(start), err)
		}
		return 0, nil
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	d.st.add(kind, resp.StatusCode, time.Since(start), nil)
	return resp.StatusCode, b
}

// poll is one cycle of the device: the root, and whatever it asks for.
func (d *device) poll(ctx context.Context) {
	root := d.base + "/" + d.id
	code, body := d.do(ctx, "poll", "GET", root, "")
	if code != 200 {
		return
	}
	var r struct {
		Links map[string]struct {
			Href string `json:"href"`
		} `json:"_links"`
	}
	if json.Unmarshal(body, &r) != nil {
		return
	}
	if _, ok := r.Links["configData"]; ok {
		d.do(ctx, "config", "PUT", root+"/configData",
			`{"mode":"merge","data":{"device_type":"load","slot":"A","os_version":"25.7.2"}}`)
	}
	if !d.act {
		return
	}
	if l, ok := r.Links["deploymentBase"]; ok {
		href := l.Href
		code, body := d.do(ctx, "deploy", "GET", href, "")
		if code != 200 {
			return
		}
		var dep struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(body, &dep) == nil && dep.ID != "" {
			fb := root + "/deploymentBase/" + dep.ID + "/feedback"
			d.do(ctx, "feedback", "POST", fb, `{"status":{"execution":"proceeding","result":{"finished":"none"},"details":["load test"]}}`)
			d.do(ctx, "feedback", "POST", fb, `{"status":{"execution":"closed","result":{"finished":"success"},"details":["load test"]}}`)
		}
	}
	if l, ok := r.Links["cancelAction"]; ok {
		parts := strings.Split(l.Href, "/")
		d.do(ctx, "feedback", "POST", root+"/cancelAction/"+parts[len(parts)-1]+"/feedback",
			`{"status":{"execution":"closed","result":{"finished":"success"}}}`)
	}
}

func main() {
	url := flag.String("url", "http://localhost:8080", "server")
	tenant := flag.String("tenant", "DEFAULT", "tenant")
	token := flag.String("token", os.Getenv("QAWK_GATEWAY_TOKEN"), "gateway token")
	n := flag.Int("devices", 1000, "simulated devices")
	interval := flag.Duration("interval", 30*time.Second, "polling interval of each device")
	ramp := flag.Duration("ramp", 30*time.Second, "time over which the devices start")
	duration := flag.Duration("duration", 2*time.Minute, "how long to run, after the ramp")
	prefix := flag.String("prefix", "load-", "controller id prefix")
	act := flag.Bool("act", false, "install whatever is assigned, and cancel when told")
	flag.Parse()
	if *token == "" {
		fmt.Fprintln(os.Stderr, "a gateway token is required (-token or QAWK_GATEWAY_TOKEN)")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, *ramp+*duration)
	defer cancel()

	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		MaxIdleConns: *n, MaxIdleConnsPerHost: *n, IdleConnTimeout: 90 * time.Second,
	}}
	st := &stats{codes: map[string]int{}}
	base := strings.TrimRight(*url, "/") + "/" + *tenant + "/controller/v1"

	fmt.Printf("%d devices polling %s every %v, starting over %v, for %v\n", *n, *url, *interval, *ramp, *duration)
	var wg sync.WaitGroup
	for i := 0; i < *n; i++ {
		d := &device{id: fmt.Sprintf("%s%05d", *prefix, i), client: client, base: base, token: *token, act: *act, st: st}
		delay := time.Duration(rand.Int63n(int64(*ramp) + 1))
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			t := time.NewTicker(*interval)
			defer t.Stop()
			for {
				d.poll(ctx)
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}

	var all []time.Duration
	allCodes := map[string]int{}
	start := time.Now()
	last := start
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	for {
		select {
		case <-tick.C:
		case <-done:
			l, c := st.take()
			all = append(all, l...)
			for k, v := range c {
				allCodes[k] += v
			}
			fmt.Println(strings.Repeat("-", 100))
			report("total", all, allCodes, time.Since(start).Seconds())
			return
		}
		l, c := st.take()
		now := time.Now()
		report(fmt.Sprintf("%3.0fs", now.Sub(start).Seconds()), append([]time.Duration(nil), l...), c, now.Sub(last).Seconds())
		last = now
		all = append(all, l...)
		for k, v := range c {
			allCodes[k] += v
		}
	}
}
