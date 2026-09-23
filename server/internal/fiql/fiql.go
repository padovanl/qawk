// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package fiql turns hawkBit's query language (FIQL/RSQL, the "q" parameter)
// into a SQL condition.
//
//	expr       := and ( ( ',' | ' or ' ) and )*
//	and        := constraint ( ( ';' | ' and ' ) constraint )*
//	constraint := '(' expr ')' | selector op argument
//	op         := '==' | '!=' | '=gt=' | '=ge=' | '=lt=' | '=le=' | '=in=' | '=out='
//	              | '<' | '<=' | '>' | '>='
//	argument   := value | '(' value ( ',' value )* ')'
//
// Behaviour matched to hawkBit, because the console and the scripts were
// written against it:
//
//   - field names are case-insensitive (controllerId, controllerid);
//   - string comparisons are case-insensitive, and '*' is a wildcard;
//   - a field the entity does not have, or an enum value outside the enum, is
//     400 rsqlInvalidField; anything unparseable is 400 rsqlParamSyntax.
//
// Every field is declared per entity, with the SQL it maps to. Nothing typed
// by a client ever reaches SQL except as a bound parameter.
package fiql

import (
	"strconv"
	"strings"

	"qawk/internal/httpx"
)

type Kind int

const (
	String Kind = iota
	Number
	Bool
	Enum
)

// Field is one queryable name.
//
// A plain field has a Column, an SQL expression compared directly. A field
// that needs a join or a subquery (tags, attributes) has a Custom builder
// instead, which receives the operator and the values and returns a whole
// condition.
type Field struct {
	Column string
	Kind   Kind
	Values []string // allowed values for Enum, lower case
	Custom func(op string, vals []string, bind Binder) (string, *httpx.Error)
}

// Binder adds a parameter and returns its placeholder ($n).
type Binder func(v any) string

// Fields is the vocabulary of one entity.
type Fields struct {
	Plain map[string]Field
	// Prefix fields carry a key after a dot: attribute.<key>, metadata.<key>.
	// The function builds the field for that key.
	Prefix map[string]func(key string) Field
}

func (f *Fields) lookup(name string) (Field, bool) {
	n := strings.ToLower(name)
	if fl, ok := f.Plain[n]; ok {
		return fl, true
	}
	if i := strings.IndexByte(n, '.'); i > 0 && i < len(n)-1 {
		if mk, ok := f.Prefix[n[:i]]; ok {
			// the key keeps its original case: attributes are case-sensitive
			return mk(name[i+1:]), true
		}
	}
	return Field{}, false
}

// Compile parses q and returns the SQL condition for it. An empty q is TRUE.
func Compile(q string, f *Fields, bind Binder) (string, *httpx.Error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return "TRUE", nil
	}
	p := &parser{src: q, f: f, bind: bind}
	p.lex()
	if p.err != nil {
		return "", p.err
	}
	sql := p.expr()
	if p.err != nil {
		return "", p.err
	}
	if p.pos < len(p.toks) {
		return "", httpx.RSQLSyntax("unexpected " + p.toks[p.pos].s)
	}
	return sql, nil
}

// Sort maps sort keys onto columns; only plain fields can be sorted on.
// def is used when there are none.
func Sort(keys []httpx.SortKey, f *Fields, def string) (string, *httpx.Error) {
	if len(keys) == 0 {
		return def, nil
	}
	parts := make([]string, 0, len(keys)+1)
	for _, k := range keys {
		fl, ok := f.Plain[k.Field]
		if !ok || fl.Column == "" {
			return "", httpx.SortField("cannot sort on " + k.Field)
		}
		dir := " ASC"
		if k.Desc {
			dir = " DESC"
		}
		parts = append(parts, fl.Column+dir)
	}
	// a stable order for equal keys, or paging would repeat and skip rows
	parts = append(parts, def)
	return strings.Join(parts, ", "), nil
}

// ------------------------------------------------------------------- lexer

type tokKind int

const (
	tWord tokKind = iota
	tOp
	tAnd
	tOr
	tOpen
	tClose
)

type tok struct {
	k      tokKind
	s      string
	quoted bool
}

var ops = []string{"=in=", "=out=", "=gt=", "=ge=", "=lt=", "=le=", "==", "!=", "<=", ">=", "<", ">"}

type parser struct {
	src  string
	toks []tok
	pos  int
	f    *Fields
	bind Binder
	err  *httpx.Error
}

func (p *parser) lex() {
	s := p.src
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			// " and " / " or " as words, between constraints
			rest := strings.ToLower(s[i:])
			if strings.HasPrefix(rest, " and ") {
				p.toks = append(p.toks, tok{k: tAnd, s: "and"})
				i += 4
				continue
			}
			if strings.HasPrefix(rest, " or ") {
				p.toks = append(p.toks, tok{k: tOr, s: "or"})
				i += 3
				continue
			}
			i++
		case c == '(':
			p.toks = append(p.toks, tok{k: tOpen, s: "("})
			i++
		case c == ')':
			p.toks = append(p.toks, tok{k: tClose, s: ")"})
			i++
		case c == ';':
			p.toks = append(p.toks, tok{k: tAnd, s: ";"})
			i++
		case c == ',':
			p.toks = append(p.toks, tok{k: tOr, s: ","})
			i++
		case c == '"' || c == '\'':
			var b strings.Builder
			j := i + 1
			closed := false
			for j < len(s) {
				if s[j] == '\\' && j+1 < len(s) {
					b.WriteByte(s[j+1])
					j += 2
					continue
				}
				if s[j] == c {
					closed = true
					break
				}
				b.WriteByte(s[j])
				j++
			}
			if !closed {
				p.err = httpx.RSQLSyntax("unterminated quoted value")
				return
			}
			p.toks = append(p.toks, tok{k: tWord, s: b.String(), quoted: true})
			i = j + 1
		default:
			if op := opAt(s, i); op != "" {
				p.toks = append(p.toks, tok{k: tOp, s: op})
				i += len(op)
				continue
			}
			j := i
			for j < len(s) && !strings.ContainsRune(" \t\n();,'\"", rune(s[j])) && opAt(s, j) == "" {
				j++
			}
			if j == i { // a lone '!' or '=' that is not an operator
				p.err = httpx.RSQLSyntax("unexpected character " + string(c))
				return
			}
			p.toks = append(p.toks, tok{k: tWord, s: s[i:j]})
			i = j
		}
	}
}

func opAt(s string, i int) string {
	for _, o := range ops {
		if strings.HasPrefix(s[i:], o) {
			return o
		}
	}
	return ""
}

// ------------------------------------------------------------------ parser

func (p *parser) peek() *tok {
	if p.pos < len(p.toks) {
		return &p.toks[p.pos]
	}
	return nil
}

func (p *parser) expr() string {
	parts := []string{p.and()}
	for p.err == nil {
		t := p.peek()
		if t == nil || t.k != tOr {
			break
		}
		p.pos++
		parts = append(parts, p.and())
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func (p *parser) and() string {
	parts := []string{p.constraint()}
	for p.err == nil {
		t := p.peek()
		if t == nil || t.k != tAnd {
			break
		}
		p.pos++
		parts = append(parts, p.constraint())
	}
	if len(parts) == 1 {
		return parts[0]
	}
	return "(" + strings.Join(parts, " AND ") + ")"
}

func (p *parser) constraint() string {
	if p.err != nil {
		return ""
	}
	t := p.peek()
	if t == nil {
		p.err = httpx.RSQLSyntax("the query ends where a condition was expected")
		return ""
	}
	if t.k == tOpen {
		p.pos++
		inner := p.expr()
		if p.err != nil {
			return ""
		}
		if c := p.peek(); c == nil || c.k != tClose {
			p.err = httpx.RSQLSyntax("missing )")
			return ""
		}
		p.pos++
		return inner
	}
	if t.k != tWord || t.quoted {
		p.err = httpx.RSQLSyntax("expected a field name, got " + t.s)
		return ""
	}
	name := t.s
	p.pos++
	o := p.peek()
	if o == nil || o.k != tOp {
		p.err = httpx.RSQLSyntax("expected an operator after " + name)
		return ""
	}
	op := canonical(o.s)
	p.pos++
	vals := p.arguments(op)
	if p.err != nil {
		return ""
	}
	field, ok := p.f.lookup(name)
	if !ok {
		p.err = httpx.RSQLField("unknown field " + name)
		return ""
	}
	sql, err := build(field, op, vals, p.bind)
	if err != nil {
		p.err = err
		return ""
	}
	return sql
}

func canonical(op string) string {
	switch op {
	case "<":
		return "=lt="
	case "<=":
		return "=le="
	case ">":
		return "=gt="
	case ">=":
		return "=ge="
	}
	return op
}

func (p *parser) arguments(op string) []string {
	t := p.peek()
	if t == nil {
		p.err = httpx.RSQLSyntax("a value is missing after " + op)
		return nil
	}
	if t.k == tOpen {
		p.pos++
		var vals []string
		for {
			v := p.peek()
			if v == nil || v.k != tWord {
				p.err = httpx.RSQLSyntax("expected a value in the list")
				return nil
			}
			vals = append(vals, v.s)
			p.pos++
			n := p.peek()
			if n != nil && n.k == tOr {
				p.pos++
				continue
			}
			if n != nil && n.k == tClose {
				p.pos++
				break
			}
			p.err = httpx.RSQLSyntax("expected , or ) in the list")
			return nil
		}
		if op != "=in=" && op != "=out=" && len(vals) > 1 {
			p.err = httpx.RSQLSyntax(op + " takes a single value")
			return nil
		}
		return vals
	}
	if t.k != tWord {
		p.err = httpx.RSQLSyntax("a value is missing after " + op)
		return nil
	}
	p.pos++
	return []string{t.s}
}

// ---------------------------------------------------------------- building

// Like turns a value with '*' wildcards into an ILIKE pattern, escaping the
// characters ILIKE would otherwise treat as wildcards of its own.
func Like(v string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`, `*`, `%`)
	return r.Replace(v)
}

func build(f Field, op string, vals []string, bind Binder) (string, *httpx.Error) {
	if f.Custom != nil {
		return f.Custom(op, vals, bind)
	}
	return Compare(f.Column, f.Kind, f.Values, op, vals, bind)
}

// Compare builds a condition on one SQL expression. It is exported for the
// Custom builders, which compare a column of their own subquery.
func Compare(col string, kind Kind, enum []string, op string, vals []string, bind Binder) (string, *httpx.Error) {
	switch kind {
	case Number:
		// A value that is not a number matches nothing, it is not an error:
		// that is what hawkBit does with id==abc, and what the console's
		// filter editor was calibrated against.
		nums := make([]string, 0, len(vals))
		for _, v := range vals {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				continue
			}
			nums = append(nums, bind(n))
		}
		if len(nums) == 0 {
			if op == "!=" || op == "=out=" {
				return "TRUE", nil
			}
			return "FALSE", nil
		}
		return scalar(col, op, nums), nil
	case Bool:
		bs := make([]string, len(vals))
		for i, v := range vals {
			b, err := strconv.ParseBool(strings.ToLower(v))
			if err != nil {
				return "", httpx.RSQLField(v + " is not true or false")
			}
			bs[i] = bind(b)
		}
		return scalar(col, op, bs), nil
	case Enum:
		es := make([]string, len(vals))
		for i, v := range vals {
			lv := strings.ToLower(v)
			ok := false
			for _, a := range enum {
				if a == lv {
					ok = true
				}
			}
			if !ok {
				return "", httpx.RSQLField(v + " is not one of " + strings.Join(enum, ", "))
			}
			es[i] = bind(lv)
		}
		return scalar("lower("+col+")", op, es), nil
	}
	// strings: case-insensitive, '*' is a wildcard
	switch op {
	case "==":
		return col + " ILIKE " + bind(Like(vals[0])), nil
	case "!=":
		return "(" + col + " IS NULL OR " + col + " NOT ILIKE " + bind(Like(vals[0])) + ")", nil
	case "=in=", "=out=":
		ors := make([]string, len(vals))
		for i, v := range vals {
			ors[i] = col + " ILIKE " + bind(Like(v))
		}
		in := "(" + strings.Join(ors, " OR ") + ")"
		if op == "=out=" {
			return "(" + col + " IS NULL OR NOT " + in + ")", nil
		}
		return in, nil
	default:
		return col + sqlOp(op) + bind(vals[0]), nil
	}
}

func scalar(col, op string, vals []string) string {
	switch op {
	case "=in=":
		return col + " IN (" + strings.Join(vals, ", ") + ")"
	case "=out=":
		return "(" + col + " IS NULL OR " + col + " NOT IN (" + strings.Join(vals, ", ") + "))"
	case "!=":
		return "(" + col + " IS NULL OR " + col + " <> " + vals[0] + ")"
	default:
		return col + sqlOp(op) + vals[0]
	}
}

func sqlOp(op string) string {
	switch op {
	case "==":
		return " = "
	case "=gt=":
		return " > "
	case "=ge=":
		return " >= "
	case "=lt=":
		return " < "
	case "=le=":
		return " <= "
	}
	return " = "
}

// Exists builds a Custom field that holds when a related row matches: a tag
// with that name, an attribute with that value. from is the subquery's FROM
// and join condition ("target_tag_assignments ta JOIN target_tags tg ON ...
// WHERE ta.target_id = t.id"), col the column compared.
//
// For the negative operators (!=, =out=) the whole thing is negated: a
// target "without tag x" is one that has no such tag, including one that
// has no tags at all.
func Exists(from, col string) func(op string, vals []string, bind Binder) (string, *httpx.Error) {
	return func(op string, vals []string, bind Binder) (string, *httpx.Error) {
		pos := op
		neg := false
		switch op {
		case "!=":
			pos, neg = "==", true
		case "=out=":
			pos, neg = "=in=", true
		}
		cond, err := Compare(col, String, nil, pos, vals, bind)
		if err != nil {
			return "", err
		}
		q := "EXISTS (SELECT 1 FROM " + from + " AND " + cond + ")"
		if neg {
			return "NOT " + q, nil
		}
		return q, nil
	}
}

// KeyValue builds a Custom field for one key of a key/value table
// (attribute.<key>, metadata.<key>). The key is matched exactly, the value
// like any string.
func KeyValue(table, ownerCol, owner, keyCol, valCol, key string) Field {
	return Field{Custom: func(op string, vals []string, bind Binder) (string, *httpx.Error) {
		from := table + " kv WHERE kv." + ownerCol + " = " + owner + " AND kv." + keyCol + " = " + bind(key)
		return Exists(from, "kv."+valCol)(op, vals, bind)
	}}
}
