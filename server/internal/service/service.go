// Package service is what Qawk does, independent of how it is asked.
//
// Assigning a set, a device polling, a device reporting, a rollout moving on
// to its next group: each is a method here, running in one transaction. The
// Management API, the DDI API and the background jobs call these; none of
// them changes the database on its own. A second protocol (DMF over AMQP)
// will call the same methods.
package service

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"qawk/internal/artifact"
	"qawk/internal/httpx"
	"qawk/internal/store"
)

type Service struct {
	st  *store.Store
	art artifact.Store
	log *slog.Logger
}

func New(st *store.Store, art artifact.Store, log *slog.Logger) *Service {
	return &Service{st: st, art: art, log: log}
}

func (s *Service) Store() *store.Store        { return s.st }
func (s *Service) Artifacts() artifact.Store { return s.art }

// ------------------------------------------------------------------ errors
//
// The errors hawkBit gives for business rules, with its codes: the console
// shows these messages to the operator, and branches on some of the codes.

const repoExc = "org.eclipse.hawkbit.repository.exception."

func errIncomplete(typeName string, missing []string) error {
	return httpx.Custom(http.StatusBadRequest, "hawkbit.server.error.distributionset.incomplete",
		repoExc+"IncompleteDistributionSetException",
		fmt.Sprintf("Distribution set of type %s is incomplete: %s", typeName, strings.Join(missing, ", ")))
}

func errInvalidDS(label string) error {
	return httpx.Custom(http.StatusBadRequest, "hawkbit.server.error.distributionset.invalid",
		repoExc+"InvalidDistributionSetException",
		fmt.Sprintf("Distribution set %s is invalidated and can no longer be assigned", label))
}

func errIncompatible(targetTypes []string, dsType string) error {
	return httpx.Custom(http.StatusBadRequest, "hawkbit.server.error.target.type.incompatible",
		repoExc+"IncompatibleTargetTypeException",
		fmt.Sprintf("Targets of types [%s] are not compatible with distribution set of type %s",
			strings.Join(targetTypes, ", "), dsType))
}

func errLocked(entity string, id any) error {
	return httpx.Custom(http.StatusBadRequest, "hawkbit.server.error.repo.entityLocked",
		repoExc+"LockedException",
		fmt.Sprintf("%s %v is locked: it has been assigned, and what it contains can no longer change", entity, id))
}

func errNotCancelable(id int64) error {
	return httpx.Custom(http.StatusBadRequest, "hawkbit.server.error.action.notcancelable",
		repoExc+"CancelActionNotAllowedException",
		fmt.Sprintf("Action %d is not active and cannot be canceled", id))
}

func errQuota(msg string) error {
	return httpx.Custom(http.StatusForbidden, "hawkbit.server.error.quota.tooManyEntries",
		repoExc+"AssignmentQuotaExceededException", msg)
}

// ErrGone is a report on an action that is already closed. hawkBit answers
// 410 with no body, and SWUpdate treats it as "nothing more to say".
var ErrGone = httpx.Custom(http.StatusGone, "", "", "")
