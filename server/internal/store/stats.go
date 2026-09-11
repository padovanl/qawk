package store

import "context"

// Stats is what /metrics reads from the database at each scrape: small
// aggregate queries, one each.
type Stats struct {
	TargetsByStatus map[string]int64
	ActionsActive   int64
	RolloutsRunning int64
	ReleasesPending int64
	ReleasesHalted  int64
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	st := Stats{TargetsByStatus: map[string]int64{}}
	rows, err := s.pool.Query(ctx, `SELECT update_status, count(*) FROM targets WHERE tenant = $1 GROUP BY 1`, s.tenant)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var k string
		var n int64
		if err := rows.Scan(&k, &n); err != nil {
			rows.Close()
			return st, err
		}
		st.TargetsByStatus[k] = n
	}
	rows.Close()
	err = s.pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM actions WHERE tenant = $1 AND active),
		       (SELECT count(*) FROM rollouts WHERE tenant = $1 AND status = 'running'),
		       (SELECT count(*) FROM fleet_releases WHERE tenant = $1 AND status = 'waiting_for_approval'),
		       (SELECT count(*) FROM fleet_releases WHERE tenant = $1 AND status = 'halted')`,
		s.tenant).Scan(&st.ActionsActive, &st.RolloutsRunning, &st.ReleasesPending, &st.ReleasesHalted)
	return st, err
}

// PoolStats is the connection pool of this instance.
func (s *Store) PoolStats() (acquired, idle, total int32) {
	p := s.pool.Stat()
	return p.AcquiredConns(), p.IdleConns(), p.TotalConns()
}
