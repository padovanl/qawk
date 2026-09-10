package mgmt

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
	"qawk/internal/service"
	"qawk/internal/store"
)

func (a *API) rolloutRoutes(r chi.Router) {
	need(r, "READ_ROLLOUT").Get("/rollouts", a.listRollouts)
	need(r, "CREATE_ROLLOUT").Post("/rollouts", a.createRollout)
	need(r, "READ_ROLLOUT").Get("/rollouts/{rolloutId}", a.getRollout)
	need(r, "UPDATE_ROLLOUT").Put("/rollouts/{rolloutId}", a.updateRollout)
	need(r, "DELETE_ROLLOUT").Delete("/rollouts/{rolloutId}", a.deleteRollout)
	for _, c := range []string{"start", "pause", "resume", "triggerNextGroup"} {
		need(r, "HANDLE_ROLLOUT").Post("/rollouts/{rolloutId}/"+c, a.rolloutCommand(c))
	}
	need(r, "APPROVE_ROLLOUT").Post("/rollouts/{rolloutId}/approve", a.rolloutCommand("approve"))
	need(r, "APPROVE_ROLLOUT").Post("/rollouts/{rolloutId}/deny", a.rolloutCommand("deny"))
	need(r, "HANDLE_ROLLOUT").Post("/rollouts/{rolloutId}/stop", a.stopRollout)
	need(r, "CREATE_ROLLOUT").Post("/rollouts/{rolloutId}/retry", a.retryRollout)
	need(r, "READ_ROLLOUT").Get("/rollouts/{rolloutId}/deploygroups", a.listGroups)
	need(r, "READ_ROLLOUT").Get("/rollouts/{rolloutId}/deploygroups/{groupId}", a.getGroup)
	need(r, "READ_ROLLOUT").Get("/rollouts/{rolloutId}/deploygroups/{groupId}/targets", a.groupTargetList)
}

func (a *API) rolloutOf(w http.ResponseWriter, r *http.Request) (model.Rollout, bool) {
	rid, found := pathID(w, r, "rolloutId", "Rollout")
	if !found {
		return model.Rollout{}, false
	}
	o, err := a.st.Rollout(r.Context(), a.st.DB(), rid)
	if err != nil {
		fail(w, err)
		return o, false
	}
	return o, true
}

// rolloutFull renders a rollout with its group count and its per-status
// totals, as a single rollout is shown.
func (a *API) rolloutFull(r *http.Request, o model.Rollout) (J, error) {
	groups, err := a.st.AllGroups(r.Context(), a.st.DB(), o.ID)
	if err != nil {
		return nil, err
	}
	counts, err := a.st.StatusCounts(r.Context(), a.st.DB(), o.ID, nil)
	if err != nil {
		return nil, err
	}
	return rolloutJSON(a.base(r), o, len(groups), counts, true), nil
}

// listRollouts: the per-status totals are only computed with
// ?representation=full, as in hawkBit -- they cost a query per rollout.
func (a *API) listRollouts(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	ros, total, err := a.st.Rollouts(r.Context(), p)
	if err != nil {
		fail(w, err)
		return
	}
	full := r.URL.Query().Get("representation") == "full"
	b := a.base(r)
	out := make([]map[string]any, 0, len(ros))
	for _, o := range ros {
		groups, err := a.st.AllGroups(r.Context(), a.st.DB(), o.ID)
		if err != nil {
			fail(w, err)
			return
		}
		var counts map[string]int64
		if full {
			if counts, err = a.st.StatusCounts(r.Context(), a.st.DB(), o.ID, nil); err != nil {
				fail(w, err)
				return
			}
		}
		out = append(out, rolloutJSON(b, o, len(groups), counts, false))
	}
	sendList(w, out, total)
}

type conditionBody struct {
	Condition  string `json:"condition"`
	Action     string `json:"action"`
	Expression string `json:"expression"`
}

func (c *conditionBody) model(isAction bool) *model.Condition {
	if c == nil {
		return nil
	}
	name := c.Condition
	if isAction {
		name = c.Action
	}
	return &model.Condition{Condition: name, Expression: c.Expression}
}

type rolloutBody struct {
	Name                 string         `json:"name"`
	Description          string         `json:"description"`
	DistributionSetID    int64          `json:"distributionSetId"`
	TargetFilterQuery    string         `json:"targetFilterQuery"`
	AmountGroups         int            `json:"amountGroups"`
	Type                 string         `json:"type"`
	ForceTime            int64          `json:"forcetime"`
	Weight               *int           `json:"weight"`
	StartAt              *int64         `json:"startAt"`
	ConfirmationRequired *bool          `json:"confirmationRequired"`
	Dynamic              bool           `json:"dynamic"`
	SuccessCondition     *conditionBody `json:"successCondition"`
	SuccessAction        *conditionBody `json:"successAction"`
	ErrorCondition       *conditionBody `json:"errorCondition"`
	ErrorAction          *conditionBody `json:"errorAction"`
	Groups               []struct {
		Name                 string         `json:"name"`
		Description          string         `json:"description"`
		TargetFilterQuery    string         `json:"targetFilterQuery"`
		TargetPercentage     float64        `json:"targetPercentage"`
		ConfirmationRequired *bool          `json:"confirmationRequired"`
		SuccessCondition     *conditionBody `json:"successCondition"`
		SuccessAction        *conditionBody `json:"successAction"`
		ErrorCondition       *conditionBody `json:"errorCondition"`
		ErrorAction          *conditionBody `json:"errorAction"`
	} `json:"groups"`
}

func (a *API) createRollout(w http.ResponseWriter, r *http.Request) {
	var b rolloutBody
	if !decode(w, r, &b) {
		return
	}
	def := service.RolloutDef{
		Name: b.Name, Description: b.Description, DSID: b.DistributionSetID, TargetFilterQuery: b.TargetFilterQuery,
		ActionType: b.Type, ForceTime: b.ForceTime, Weight: b.Weight, StartAt: b.StartAt,
		ConfirmationRequired: b.ConfirmationRequired, Dynamic: b.Dynamic, AmountGroups: b.AmountGroups,
		SuccessCondition: b.SuccessCondition.model(false), SuccessAction: b.SuccessAction.model(true),
		ErrorCondition: b.ErrorCondition.model(false), ErrorAction: b.ErrorAction.model(true),
	}
	for _, g := range b.Groups {
		def.Groups = append(def.Groups, service.GroupDef{
			Name: g.Name, Description: g.Description, TargetFilterQuery: g.TargetFilterQuery,
			TargetPercentage: g.TargetPercentage, ConfirmationRequired: g.ConfirmationRequired,
			SuccessCondition: g.SuccessCondition.model(false), SuccessAction: g.SuccessAction.model(true),
			ErrorCondition: g.ErrorCondition.model(false), ErrorAction: g.ErrorAction.model(true),
		})
	}
	id, err := a.svc.CreateRollout(r.Context(), user(r), def)
	if err != nil {
		fail(w, err)
		return
	}
	o, err := a.st.Rollout(r.Context(), a.st.DB(), id)
	if err != nil {
		fail(w, err)
		return
	}
	j, err := a.rolloutFull(r, o)
	if err != nil {
		fail(w, err)
		return
	}
	sendCreated(w, j)
}

func (a *API) getRollout(w http.ResponseWriter, r *http.Request) {
	o, found := a.rolloutOf(w, r)
	if !found {
		return
	}
	j, err := a.rolloutFull(r, o)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, j)
}

func (a *API) updateRollout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if !decode(w, r, &body) {
		return
	}
	o, found := a.rolloutOf(w, r)
	if !found {
		return
	}
	if body.Name != nil {
		o.Name = *body.Name
	}
	if body.Description != nil {
		o.Description = *body.Description
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error {
		return a.st.UpdateRollout(r.Context(), tx, user(r), now, o)
	}); err != nil {
		fail(w, err)
		return
	}
	a.getRollout(w, r)
}

func (a *API) deleteRollout(w http.ResponseWriter, r *http.Request) {
	o, found := a.rolloutOf(w, r)
	if !found {
		return
	}
	if err := a.svc.DeleteRollout(r.Context(), user(r), o.ID); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) rolloutCommand(cmd string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		o, found := a.rolloutOf(w, r)
		if !found {
			return
		}
		var remark *string
		if cmd == "approve" || cmd == "deny" {
			if v := r.URL.Query().Get("remark"); v != "" {
				remark = &v
			}
		}
		if err := a.svc.RolloutCommand(r.Context(), user(r), o.ID, cmd, remark); err != nil {
			fail(w, err)
			return
		}
		noContent(w)
	}
}

func (a *API) stopRollout(w http.ResponseWriter, r *http.Request) {
	o, found := a.rolloutOf(w, r)
	if !found {
		return
	}
	if err := a.svc.StopRollout(r.Context(), user(r), o.ID); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) retryRollout(w http.ResponseWriter, r *http.Request) {
	o, found := a.rolloutOf(w, r)
	if !found {
		return
	}
	id, err := a.svc.RetryRollout(r.Context(), user(r), o.ID)
	if err != nil {
		fail(w, err)
		return
	}
	n, err := a.st.Rollout(r.Context(), a.st.DB(), id)
	if err != nil {
		fail(w, err)
		return
	}
	j, err := a.rolloutFull(r, n)
	if err != nil {
		fail(w, err)
		return
	}
	sendCreated(w, j)
}

// ------------------------------------------------------------------ groups

func (a *API) listGroups(w http.ResponseWriter, r *http.Request) {
	o, found := a.rolloutOf(w, r)
	if !found {
		return
	}
	p, good := pageOf(w, r)
	if !good {
		return
	}
	gs, total, err := a.st.Groups(r.Context(), o.ID, p)
	if err != nil {
		fail(w, err)
		return
	}
	full := r.URL.Query().Get("representation") == "full"
	b := a.base(r)
	out := make([]map[string]any, 0, len(gs))
	for _, g := range gs {
		var counts map[string]int64
		if full {
			gid := g.ID
			if counts, err = a.st.StatusCounts(r.Context(), a.st.DB(), o.ID, &gid); err != nil {
				fail(w, err)
				return
			}
		}
		out = append(out, groupJSON(b, g, counts))
	}
	sendList(w, out, total)
}

func (a *API) groupOf(w http.ResponseWriter, r *http.Request) (model.RolloutGroup, bool) {
	o, found := a.rolloutOf(w, r)
	if !found {
		return model.RolloutGroup{}, false
	}
	gid, found := pathID(w, r, "groupId", "RolloutGroup")
	if !found {
		return model.RolloutGroup{}, false
	}
	g, err := a.st.Group(r.Context(), a.st.DB(), o.ID, gid)
	if err != nil {
		fail(w, err)
		return g, false
	}
	return g, true
}

func (a *API) getGroup(w http.ResponseWriter, r *http.Request) {
	g, found := a.groupOf(w, r)
	if !found {
		return
	}
	gid := g.ID
	counts, err := a.st.StatusCounts(r.Context(), a.st.DB(), g.RolloutID, &gid)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, groupJSON(a.base(r), g, counts))
}

func (a *API) groupTargetList(w http.ResponseWriter, r *http.Request) {
	g, found := a.groupOf(w, r)
	if found {
		a.sendTargets(w, r, store.InGroup(g.ID))
	}
}
