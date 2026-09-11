package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Centres (a Qawk addition).
//
// A device says which centre it is in (attribute.centerid, by default). A
// centre is put in a channel -- a fleet -- and every device of it follows:
// the 6hd with its st05 and hyper, the neo-intel. A centre moved from beta
// to prod moves them all, and they get prod's release (or, for the devices
// of a system, prod's system deployments). A single machine taken to a trade
// show is lent to a temporary channel (expo) and stays there until it is sent
// home; a device of a centre is not moved by hand into another channel, since
// its centre would take it back at once.

func (s *Service) Centres(ctx context.Context) (string, []model.Centre, error) {
	field, err := s.st.CentreField(ctx)
	if err != nil {
		return "", nil, err
	}
	cs, err := s.st.Centres(ctx, field)
	return field, cs, err
}

// SetCentreField sets where the devices say their centre.
func (s *Service) SetCentreField(ctx context.Context, user, field string) error {
	field = strings.TrimSpace(field)
	if !keyFieldRE.MatchString(field) {
		return httpx.Validation("the centre is attribute.<key> or metadata.<key>, such as attribute.centerid")
	}
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error { return s.st.SetCentreField(ctx, tx, field) })
}

// SetCentres puts centres in a channel (nil: in none); their devices follow
// at once.
func (s *Service) SetCentres(ctx context.Context, user string, centres []string, fleet *int64) error {
	var clean []string
	for _, c := range centres {
		if c = strings.TrimSpace(c); c != "" {
			clean = append(clean, c)
		}
	}
	if len(clean) == 0 {
		return httpx.Validation("name at least one centre")
	}
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if fleet != nil {
			f, err := s.st.Fleet(ctx, tx, *fleet)
			if err != nil {
				return httpx.Validation(fmt.Sprintf("there is no fleet %d", *fleet))
			}
			if f.Temporary {
				return httpx.Validation(f.Name + " is temporary: a device is lent to it (Fleets → manage), not a centre")
			}
		}
		return s.st.SetCentres(ctx, tx, user, now, clean, fleet)
	})
	if err == nil {
		if e := s.tickCentres(ctx); e != nil {
			s.log.Warn("centres", "err", e)
		}
	}
	return err
}

// tickCentres puts every device in its centre's channel, a hundred per
// transaction -- a centre of four hundred devices moved is four short ones.
func (s *Service) tickCentres(ctx context.Context) error {
	field, err := s.st.CentreField(ctx)
	if err != nil {
		return err
	}
	strays, err := s.st.CentreStrays(ctx, field)
	if err != nil {
		return err
	}
	for fleet, ids := range strays {
		fid, n := fleet, len(ids)
		for len(ids) > 0 {
			k := min(assignSlice, len(ids))
			part := ids[:k]
			if err := s.st.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
				return s.st.SetFleet(ctx, tx, part, &fid, now, false)
			}); err != nil {
				return err
			}
			ids = ids[k:]
		}
		s.log.Info("devices follow their centre into its channel", "fleet", fleet, "devices", n)
	}
	return nil
}

// checkCentreMove refuses to move by hand devices whose centre is in a
// channel into another channel that is not temporary: the centre would take
// them back within seconds, silently.
func (s *Service) checkCentreMove(ctx context.Context, q store.Q, ids []int64, fleet *int64, temporary bool) error {
	if temporary {
		return nil
	}
	field, err := s.st.CentreField(ctx)
	if err != nil {
		return err
	}
	of, err := s.st.CentresOf(ctx, q, ids, field)
	if err != nil {
		return err
	}
	for _, c := range of {
		if c.FleetID != nil && (fleet == nil || *c.FleetID != *fleet) {
			return httpx.Validation(fmt.Sprintf("the devices of centre %s go with their centre: move the centre "+
				"(Centres), or lend the device to a temporary channel", c.Centre))
		}
	}
	return nil
}
