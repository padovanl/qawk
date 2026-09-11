// Package cron reads the schedules of hawkBit's maintenance windows: Quartz
// cron expressions, as hawkBit takes them.
//
//	seconds minutes hours day-of-month month day-of-week [year]
//	0       0       2     *            *     ?              every day at 02:00:00
//	0       30      22    ?            *     MON-FRI        weekdays at 22:30
//
// Each field takes *, a number, a range a-b, a list a,b,c and steps */n or
// a-b/n; months and days of the week also by name (JAN, MON). As in Quartz,
// days of the week run from 1 (SUN) to 7 (SAT), and "?" in one of the two day
// fields means "whatever the other one says". L, W and # are not supported.
package cron

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type bounds struct{ lo, hi int }

var limits = [7]bounds{{0, 59}, {0, 59}, {0, 23}, {1, 31}, {1, 12}, {1, 7}, {1970, 2199}}

var fieldNames = [7]string{"seconds", "minutes", "hours", "day of month", "month", "day of week", "year"}

var monthNames = map[string]int{"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
	"JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}

var dayNames = map[string]int{"SUN": 1, "MON": 2, "TUE": 3, "WED": 4, "THU": 5, "FRI": 6, "SAT": 7}

// Schedule is a parsed expression.
type Schedule struct {
	set            [7][]bool
	domAll, dowAll bool
}

// Parse reads a Quartz expression of six or seven fields.
func Parse(expr string) (*Schedule, error) {
	f := strings.Fields(strings.ToUpper(strings.TrimSpace(expr)))
	if len(f) != 6 && len(f) != 7 {
		return nil, fmt.Errorf("%q has %d fields: a schedule has six or seven -- "+
			"seconds minutes hours day-of-month month day-of-week [year]", expr, len(f))
	}
	if len(f) == 6 {
		f = append(f, "*")
	}
	s := &Schedule{}
	for i, spec := range f {
		if spec == "?" {
			if i != 3 && i != 5 {
				return nil, fmt.Errorf("%s: ? is only for the day of month or the day of week", fieldNames[i])
			}
			spec = "*"
		}
		set, err := parseField(spec, i)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", fieldNames[i], err)
		}
		s.set[i] = set
	}
	s.domAll = f[3] == "*" || f[3] == "?"
	s.dowAll = f[5] == "*" || f[5] == "?"
	return s, nil
}

func value(v string, i int) (int, error) {
	if i == 4 {
		if n, ok := monthNames[v]; ok {
			return n, nil
		}
	}
	if i == 5 {
		if n, ok := dayNames[v]; ok {
			return n, nil
		}
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%q is not a number", v)
	}
	return n, nil
}

func parseField(spec string, i int) ([]bool, error) {
	b := limits[i]
	set := make([]bool, b.hi+1)
	// names first (JUL has an L, WED a W): only then is an L, W or # Quartz's
	names := map[string]int(nil)
	switch i {
	case 4:
		names = monthNames
	case 5:
		names = dayNames
	}
	for n, v := range names {
		spec = strings.ReplaceAll(spec, n, strconv.Itoa(v))
	}
	for _, part := range strings.Split(spec, ",") {
		if part == "" || strings.ContainsAny(part, "LW#") {
			return nil, fmt.Errorf("%q is not supported", part)
		}
		step, rng := 1, part
		if k := strings.IndexByte(part, '/'); k >= 0 {
			n, err := strconv.Atoi(part[k+1:])
			if err != nil || n < 1 {
				return nil, fmt.Errorf("%q: the step must be a positive number", part)
			}
			step, rng = n, part[:k]
		}
		lo, hi := b.lo, b.hi
		switch {
		case rng == "*":
		case strings.Contains(rng, "-"):
			x, y, _ := strings.Cut(rng, "-")
			var err error
			if lo, err = value(x, i); err != nil {
				return nil, err
			}
			if hi, err = value(y, i); err != nil {
				return nil, err
			}
		default:
			v, err := value(rng, i)
			if err != nil {
				return nil, err
			}
			lo, hi = v, v
			if strings.Contains(part, "/") { // 5/15: from 5, every 15
				hi = b.hi
			}
		}
		if lo < b.lo || hi > b.hi || lo > hi {
			return nil, fmt.Errorf("%q is outside %d-%d", part, b.lo, b.hi)
		}
		for v := lo; v <= hi; v += step {
			set[v] = true
		}
	}
	return set, nil
}

func (s *Schedule) dayOK(t time.Time) bool {
	if y := t.Year(); y < 1970 || y > 2199 || !s.set[6][y] || !s.set[4][int(t.Month())] {
		return false
	}
	dom, dow := s.set[3][t.Day()], s.set[5][int(t.Weekday())+1]
	switch {
	case s.domAll && s.dowAll:
		return true
	case s.domAll:
		return dow
	case s.dowAll:
		return dom
	}
	return dom || dow
}

func minuteOf(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), 0, 0, t.Location())
}

// Prev is the latest time the schedule fires at, at or before t and not
// before t-within, read in t's location.
func (s *Schedule) Prev(t time.Time, within time.Duration) (time.Time, bool) {
	start := t.Add(-within)
	for m := minuteOf(t); !m.Before(minuteOf(start)); {
		switch {
		case !s.dayOK(m):
			m = time.Date(m.Year(), m.Month(), m.Day(), 0, 0, 0, 0, m.Location()).Add(-time.Minute)
			continue
		case !s.set[2][m.Hour()]:
			m = time.Date(m.Year(), m.Month(), m.Day(), m.Hour(), 0, 0, 0, m.Location()).Add(-time.Minute)
			continue
		case s.set[1][m.Minute()]:
			for sec := 59; sec >= 0; sec-- {
				if f := m.Add(time.Duration(sec) * time.Second); s.set[0][sec] && !f.After(t) && !f.Before(start) {
					return f, true
				}
			}
		}
		m = m.Add(-time.Minute)
	}
	return time.Time{}, false
}

// Next is the first time the schedule fires at, at or after t and not after
// t+within, read in t's location.
func (s *Schedule) Next(t time.Time, within time.Duration) (time.Time, bool) {
	end := t.Add(within)
	for m := minuteOf(t); !m.After(end); {
		switch {
		case !s.dayOK(m):
			m = time.Date(m.Year(), m.Month(), m.Day()+1, 0, 0, 0, 0, m.Location())
			continue
		case !s.set[2][m.Hour()]:
			m = time.Date(m.Year(), m.Month(), m.Day(), m.Hour()+1, 0, 0, 0, m.Location())
			continue
		case s.set[1][m.Minute()]:
			for sec := 0; sec < 60; sec++ {
				if f := m.Add(time.Duration(sec) * time.Second); s.set[0][sec] && !f.Before(t) && !f.After(end) {
					return f, true
				}
			}
		}
		m = m.Add(time.Minute)
	}
	return time.Time{}, false
}
