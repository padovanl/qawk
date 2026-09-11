package service

import (
	"context"
	"fmt"
	"sort"

	"qawk/internal/model"
	"qawk/internal/store"
)

// Ongoing is something going on right now, as an operator thinks of it: a
// fleet's release, a rollout, or a set assigned by hand to some devices (a
// Qawk addition). The console's "In progress" is a list of these, read in one
// request whatever the size of the fleet.
type Ongoing struct {
	Kind      string // fleet, rollout, manual
	Title     string
	DSID      int64
	DSLabel   string
	DSType    string
	FleetID   *int64
	RolloutID *int64
	Status    string // the release's or the rollout's; "running" for manual
	Detail    string // "wave 3, 20% at a time", "group 2 of 4"

	Total  int64 // the devices it concerns
	Done   int64 // of which finished
	Failed int64

	// what the devices with an open action are doing
	Open, Waiting, Scheduled, Downloading, Installing, Confirming, Canceling int64

	Since int64
	By    []string
}

func (d *Ongoing) add(g store.DeploymentGroup) {
	d.Open += g.Open
	d.Scheduled += g.Scheduled
	d.Downloading += g.Downloading
	d.Installing += g.Installing
	d.Confirming += g.Confirming
	d.Canceling += g.Canceling
	if d.Since == 0 || (g.Since > 0 && g.Since < d.Since) {
		d.Since = g.Since
	}
	for _, b := range g.By {
		if b != "" && !contains(d.By, b) {
			d.By = append(d.By, b)
		}
	}
	d.Waiting = d.Open - d.Scheduled - d.Downloading - d.Installing - d.Confirming - d.Canceling
	if d.Waiting < 0 {
		d.Waiting = 0
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// Deployments lists what is going on: every fleet release still moving (or
// halted, or waiting for approval), every rollout under way, and the sets
// assigned by hand that devices are still working on.
func (s *Service) Deployments(ctx context.Context) ([]Ongoing, error) {
	groups, err := s.st.ActiveDeployments(ctx)
	if err != nil {
		return nil, err
	}
	fleets, err := s.st.Fleets(ctx)
	if err != nil {
		return nil, err
	}

	byFleet := map[int64]*Ongoing{}
	var out []*Ongoing
	for _, f := range fleets {
		st, err := s.FleetState(ctx, f)
		if err != nil {
			return nil, err
		}
		r := st.Release
		switch {
		case st.Pending != nil:
			d := &Ongoing{Kind: "fleet", Title: f.Name, DSLabel: st.Pending.DSLabel, FleetID: &st.Fleet.ID,
				Status: model.ReleasePending, Total: f.Members, Done: f.OnRelease, Since: st.Pending.RequestedAt,
				Detail: fmt.Sprintf("waiting for approval, asked by %s", st.Pending.RequestedBy)}
			if st.Pending.DSID != nil {
				d.DSID = *st.Pending.DSID
			}
			out = append(out, d)
		case r != nil && r.DSID != nil && (r.Status == model.ReleaseActive || r.Status == model.ReleaseHalted):
			d := &Ongoing{Kind: "fleet", Title: f.Name, DSID: *r.DSID, DSLabel: r.DSLabel, FleetID: &st.Fleet.ID,
				Status: r.Status, Total: f.Members, Since: since(r)}
			if p := st.Progress; p != nil {
				d.Total, d.Done, d.Failed = p.Members, p.OnRelease, p.Failed
			}
			if f.WavePercent > 0 {
				d.Detail = fmt.Sprintf("wave %d, %d%% at a time", r.Waves, f.WavePercent)
			}
			if r.Status == model.ReleaseHalted {
				d.Detail = r.Reason
			}
			byFleet[f.ID] = d
			out = append(out, d)
		}
	}

	byRollout := map[int64]*Ongoing{}
	for _, status := range []string{"running", "paused", "starting", "waiting_for_approval"} {
		ros, err := s.st.RolloutsIn(ctx, status)
		if err != nil {
			return nil, err
		}
		for _, o := range ros {
			d := &Ongoing{Kind: "rollout", Title: o.Name, DSID: o.DSID, RolloutID: &o.ID, Status: o.Status}
			if ds, err := s.st.DistributionSet(ctx, s.st.DB(), o.DSID); err == nil {
				d.DSLabel = ds.Label()
			}
			if c, err := s.st.StatusCounts(ctx, s.st.DB(), o.ID, nil); err == nil {
				for _, n := range c {
					d.Total += n
				}
				d.Done, d.Failed = c["finished"], c["error"]
			}
			if gs, err := s.st.AllGroups(ctx, s.st.DB(), o.ID); err == nil {
				for i, g := range gs {
					if g.Status == model.GroupRunning {
						d.Detail = fmt.Sprintf("group %d of %d", i+1, len(gs))
					}
				}
			}
			byRollout[o.ID] = d
			out = append(out, d)
		}
	}

	byManual := map[int64]*Ongoing{}
	for _, g := range groups {
		switch {
		case g.RolloutID != nil && byRollout[*g.RolloutID] != nil:
			byRollout[*g.RolloutID].add(g)
		case g.FleetID != nil && byFleet[*g.FleetID] != nil && byFleet[*g.FleetID].DSID == g.DSID:
			byFleet[*g.FleetID].add(g)
		default:
			d := byManual[g.DSID]
			if d == nil {
				d = &Ongoing{Kind: "manual", Title: g.DSLabel, DSID: g.DSID, DSLabel: g.DSLabel, DSType: g.DSType,
					Status: "running"}
				byManual[g.DSID] = d
				out = append(out, d)
			}
			d.add(g)
			d.Total = d.Open
		}
	}

	// halted first, then what is moving, newest first
	sort.SliceStable(out, func(i, j int) bool {
		hi, hj := out[i].Status == model.ReleaseHalted || out[i].Status == "paused",
			out[j].Status == model.ReleaseHalted || out[j].Status == "paused"
		if hi != hj {
			return hi
		}
		return out[i].Since > out[j].Since
	})
	res := make([]Ongoing, 0, len(out))
	for _, d := range out {
		if d.By == nil {
			d.By = []string{}
		}
		res = append(res, *d)
	}
	return res, nil
}
