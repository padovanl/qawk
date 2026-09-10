package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Tags, for targets and for distribution sets: two sets of tables with the
// same shape, served by the same code.

type TagKind int

const (
	TagTarget TagKind = iota
	TagDS
)

type tagTable struct {
	tags, assign, member, entity string
}

var tagTables = map[TagKind]tagTable{
	TagTarget: {"target_tags", "target_tag_assignments", "target_id", "TargetTag"},
	TagDS:     {"ds_tags", "ds_tag_assignments", "ds_id", "DistributionSetTag"},
}

const tagCols = "g.id, g.name, g.description, g.colour, g.created_at, g.created_by, g.last_modified_at, g.last_modified_by"

func scanTag(r pgx.Row) (model.Tag, error) {
	var t model.Tag
	err := r.Scan(&t.ID, &t.Name, &t.Description, &t.Colour, &t.CreatedAt, &t.CreatedBy, &t.LastModifiedAt, &t.LastModifiedBy)
	return t, err
}

func (s *Store) Tags(ctx context.Context, kind TagKind, page httpx.Page) ([]model.Tag, int64, error) {
	t := tagTables[kind]
	a := &Args{}
	out := []model.Tag{}
	total, err := list(ctx, s.pool, listSpec{
		Select: tagCols, From: t.tags + " g", Where: []string{"g.tenant = " + a.Bind(s.tenant)},
		Fields: tagFields, DefaultSort: "g.id ASC",
	}, a, page, func(r pgx.Rows) error {
		tg, err := scanTag(r)
		out = append(out, tg)
		return err
	})
	return out, total, err
}

func (s *Store) Tag(ctx context.Context, q Q, kind TagKind, id int64) (model.Tag, error) {
	t := tagTables[kind]
	tg, err := scanTag(q.QueryRow(ctx, "SELECT "+tagCols+" FROM "+t.tags+" g WHERE g.tenant = $1 AND g.id = $2", s.tenant, id))
	return tg, notFound(err, t.entity, id)
}

// TagsOf lists the tags one target or set carries.
func (s *Store) TagsOf(ctx context.Context, q Q, kind TagKind, member int64) ([]model.Tag, error) {
	t := tagTables[kind]
	rows, err := q.Query(ctx, "SELECT "+tagCols+" FROM "+t.tags+" g JOIN "+t.assign+" x ON x.tag_id = g.id WHERE x."+
		t.member+" = $1 ORDER BY g.id", member)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Tag{}
	for rows.Next() {
		tg, err := scanTag(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, tg)
	}
	return out, rows.Err()
}

func (s *Store) CreateTag(ctx context.Context, tx pgx.Tx, kind TagKind, user string, now int64, tg model.Tag) (int64, error) {
	t := tagTables[kind]
	var id int64
	err := tx.QueryRow(ctx, "INSERT INTO "+t.tags+" (tenant, name, description, colour, "+auditCols+
		") VALUES ($1, $2, $3, $4, $5, $6, $5, $6) RETURNING id",
		s.tenant, tg.Name, tg.Description, tg.Colour, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateTag(ctx context.Context, tx pgx.Tx, kind TagKind, user string, now int64, tg model.Tag) error {
	t := tagTables[kind]
	_, err := tx.Exec(ctx, "UPDATE "+t.tags+" SET name = $3, description = $4, colour = $5, last_modified_at = $6, "+
		"last_modified_by = $7 WHERE tenant = $1 AND id = $2", s.tenant, tg.ID, tg.Name, tg.Description, tg.Colour, now, user)
	return err
}

func (s *Store) DeleteTag(ctx context.Context, tx pgx.Tx, kind TagKind, id int64) error {
	t := tagTables[kind]
	tag, err := tx.Exec(ctx, "DELETE FROM "+t.tags+" WHERE tenant = $1 AND id = $2", s.tenant, id)
	if err == nil && tag.RowsAffected() == 0 {
		return httpx.NotFound(t.entity, id)
	}
	return err
}

func (s *Store) AssignTag(ctx context.Context, tx pgx.Tx, kind TagKind, tagID int64, members []int64) error {
	t := tagTables[kind]
	_, err := tx.Exec(ctx, "INSERT INTO "+t.assign+" (tag_id, "+t.member+") SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING",
		tagID, members)
	return err
}

func (s *Store) UnassignTag(ctx context.Context, tx pgx.Tx, kind TagKind, tagID int64, members []int64) error {
	t := tagTables[kind]
	_, err := tx.Exec(ctx, "DELETE FROM "+t.assign+" WHERE tag_id = $1 AND "+t.member+" = ANY($2)", tagID, members)
	return err
}

// TagMembers is the condition "carries this tag", for the member lists
// (the targets of a tag, the sets of a tag). alias is the member's alias.
func TagMembers(kind TagKind, tagID int64, alias string) func(a *Args) []string {
	t := tagTables[kind]
	return func(a *Args) []string {
		return []string{"EXISTS (SELECT 1 FROM " + t.assign + " x WHERE x.tag_id = " + a.Bind(tagID) +
			" AND x." + t.member + " = " + alias + ".id)"}
	}
}
