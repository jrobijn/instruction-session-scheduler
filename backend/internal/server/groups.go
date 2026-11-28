package server

import (
	"net/http"
	"strings"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
)

type Group struct {
	ID                        int64  `db:"id" json:"id"`
	Name                      string `db:"name" json:"name"`
	Color                     string `db:"color" json:"color"`
	IsDefault                 int64  `db:"is_default" json:"is_default"`
	Active                    int64  `db:"active" json:"active"`
	NewMemberPriority         string `db:"new_member_priority" json:"new_member_priority"`
	ReactivatedMemberPriority string `db:"reactivated_member_priority" json:"reactivated_member_priority"`
	CooldownMemberPriority    string `db:"cooldown_member_priority" json:"cooldown_member_priority"`
}

// GroupRef names a group, e.g. one a discipline is linked to.
type GroupRef struct {
	ID   int64  `db:"id" json:"id"`
	Name string `db:"name" json:"name"`
}

func (s *Server) groupRoutes() {
	s.adminRoute("GET /api/groups", func(w http.ResponseWriter, r *http.Request) error {
		type groupWithCounts struct {
			Group
			MemberCount     int64 `db:"member_count" json:"member_count"`
			DisciplineCount int64 `db:"discipline_count" json:"discipline_count"`
		}

		groups, err := db.Many[groupWithCounts](s.db, `
			SELECT g.id, g.name, g.color, g.is_default, g.active,
				g.new_member_priority, g.reactivated_member_priority, g.cooldown_member_priority,
				(SELECT COUNT(*) FROM student_groups WHERE group_id = g.id) AS member_count,
				(SELECT COUNT(*) FROM discipline_groups WHERE group_id = g.id) AS discipline_count
			FROM groups g
			ORDER BY g.name ASC`)
		if err != nil {
			return err
		}

		httpx.OK(w, groups)
		return nil
	})

	s.adminRoute("POST /api/groups", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		if in.Name == "" {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}

		if in.Color == "" {
			in.Color = "#3b82f6"
		}

		row, err := db.Get[Group](s.db, `
			INSERT INTO groups (name, color, new_member_priority, reactivated_member_priority, cooldown_member_priority)
			VALUES (?, ?, 'back', 'back', 'back')
			RETURNING id, name, color, is_default, active,
				new_member_priority, reactivated_member_priority, cooldown_member_priority`,
			in.Name, in.Color)
		if isUniqueErr(err, "groups.name") {
			httpx.Error(w, http.StatusConflict, "A group with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}

		httpx.JSON(w, http.StatusCreated, row)
		return nil
	})

	s.adminRoute("PUT /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Name                      *string `json:"name"`
			Active                    *int64  `json:"active"`
			Color                     *string `json:"color"`
			NewMemberPriority         *string `json:"new_member_priority"`
			ReactivatedMemberPriority *string `json:"reactivated_member_priority"`
			CooldownMemberPriority    *string `json:"cooldown_member_priority"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		for _, p := range []struct {
			key   string
			value *string
		}{
			{"new_member_priority", in.NewMemberPriority},
			{"reactivated_member_priority", in.ReactivatedMemberPriority},
			{"cooldown_member_priority", in.CooldownMemberPriority},
		} {
			if p.value != nil && *p.value != "front" && *p.value != "back" {
				httpx.Error(w, http.StatusBadRequest, p.key+" must be 'front' or 'back'")
				return nil
			}
		}
		row, found, err := db.One[Group](s.db, `
			UPDATE groups SET
				name = COALESCE(?, name),
				active = COALESCE(?, active),
				color = COALESCE(?, color),
				new_member_priority = COALESCE(?, new_member_priority),
				reactivated_member_priority = COALESCE(?, reactivated_member_priority),
				cooldown_member_priority = COALESCE(?, cooldown_member_priority)
			WHERE id = ?
			RETURNING id, name, color, is_default, active,
				new_member_priority, reactivated_member_priority, cooldown_member_priority`,
			in.Name, in.Active, in.Color,
			in.NewMemberPriority, in.ReactivatedMemberPriority, in.CooldownMemberPriority, id)
		if isUniqueErr(err, "groups.name") {
			httpx.Error(w, http.StatusConflict, "A group with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM timetable_groups WHERE group_id = ?", id); err != nil {
			return err
		} else if found {
			httpx.Error(w, http.StatusBadRequest, "Cannot delete a group that is assigned to timetables")
			return nil
		}

		res, err := s.db.Exec("DELETE FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/set-default", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		var row Group
		var found bool
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			var err error
			row, found, err = db.One[Group](tx, `
				UPDATE groups SET is_default = 1 WHERE id = ?
				RETURNING id, name, color, is_default, active,
					new_member_priority, reactivated_member_priority, cooldown_member_priority`, id)
			if err != nil || !found {
				return err
			}

			_, err = tx.Exec("UPDATE groups SET is_default = 0 WHERE is_default = 1 AND id != ?", id)
			return err
		})
		if err != nil {
			return err
		}

		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/unset-default", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		row, found, err := db.One[Group](s.db, `
			UPDATE groups SET is_default = 0 WHERE id = ?
			RETURNING id, name, color, is_default, active,
				new_member_priority, reactivated_member_priority, cooldown_member_priority`, id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		httpx.OK(w, row)
		return nil
	})

	// List a group's members by name, with their buddy group.
	s.adminRoute("GET /api/groups/{id}/members", func(w http.ResponseWriter, r *http.Request) error {
		groupID, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", groupID)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		// memberBuddyGroup is the buddy group a member is in. Elsewhere are its members not in
		// this group: they are never invited together, as buddies are only taken along from their
		// own group's queue.
		type memberBuddyGroup struct {
			ID        int64   `json:"id"`
			Name      string  `json:"name"` // the members' first names, as on the students list
			Elsewhere []Buddy `json:"elsewhere"`
		}

		// groupMember is a member as the group page lists them. Their place in the queue is shown
		// per timetable (see queues.go).
		type groupMember struct {
			ID            int64             `db:"id" json:"id"`
			FirstName     string            `db:"first_name" json:"first_name"`
			LastName      string            `db:"last_name" json:"last_name"`
			MembershipID  string            `db:"membership_id" json:"membership_id"`
			Active        int64             `db:"active" json:"active"`
			CooldownUntil *string           `db:"cooldown_until" json:"cooldown_until"` // as stored
			BuddyGroup    *memberBuddyGroup `db:"-" json:"buddy_group"`
		}

		members, err := db.Many[groupMember](s.db, `
			SELECT s.id, s.first_name, s.last_name, s.membership_id, s.active, s.cooldown_until
			FROM student_groups sg
			JOIN students s ON s.id = sg.student_id AND s.deleted_at IS NULL
			WHERE sg.group_id = ?
			ORDER BY s.last_name, s.first_name, s.id`, groupID)
		if err != nil {
			return err
		}

		buddyGroups, err := loadBuddyGroups(s.db)
		if err != nil {
			return err
		}

		buddyGroupOf := map[int64]*memberBuddyGroup{}
		for id, group := range buddyGroups {
			names := make([]string, len(group))
			for i, b := range group {
				names[i] = b.FirstName
			}

			bg := &memberBuddyGroup{ID: id, Name: strings.Join(names, " & "), Elsewhere: []Buddy{}}
			for _, b := range group {
				if b.GroupID == nil || *b.GroupID != groupID {
					bg.Elsewhere = append(bg.Elsewhere, b)
				}
			}

			for _, b := range group {
				buddyGroupOf[b.ID] = bg
			}
		}

		for i := range members {
			members[i].BuddyGroup = buddyGroupOf[members[i].ID]
		}

		httpx.OK(w, members)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/members", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			StudentID int64 `json:"student_id"`
		}

		in, err := decode[request](r)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return nil
		}

		studentID := in.StudentID
		if studentID == 0 {
			httpx.Error(w, http.StatusBadRequest, "student_id is required")
			return nil
		}

		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL", studentID); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}

		err = s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("DELETE FROM student_groups WHERE student_id = ?", studentID); err != nil {
				return err
			}

			_, err := tx.Exec("INSERT INTO student_groups (student_id, group_id, joined_at) VALUES (?, ?, datetime('now'))", studentID, id)
			return err
		})
		if err != nil {
			return err
		}

		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}/members/{studentId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		studentID, ok := pathID(r, "studentId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Member not found")
			return nil
		}

		if _, err := s.db.Exec("DELETE FROM student_groups WHERE student_id = ? AND group_id = ?", studentID, id); err != nil {
			return err
		}

		httpx.Success(w)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/non-members", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if q == "" {
			httpx.OK(w, []any{})
			return nil
		}

		like := "%" + q + "%"
		type searchResult struct {
			StudentRef
			CurrentGroupName *string `db:"current_group_name" json:"current_group_name"`
		}

		students, err := db.Many[searchResult](s.db, `
			SELECT s.id, s.first_name, s.last_name, s.email,
				(SELECT g.name FROM student_groups sg JOIN groups g ON g.id = sg.group_id WHERE sg.student_id = s.id) AS current_group_name
			FROM students s
			WHERE s.active = 1
				AND s.deleted_at IS NULL
				AND s.id NOT IN (SELECT student_id FROM student_groups WHERE group_id = ?)
				AND (s.first_name || ' ' || s.last_name LIKE ? OR s.email LIKE ?)
			ORDER BY s.last_name ASC, s.first_name ASC
			LIMIT 20`, id, like, like)
		if err != nil {
			return err
		}

		httpx.OK(w, students)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/disciplines", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		disciplines, err := db.Many[Discipline](s.db, `
			SELECT d.id, d.name, d.abbreviation, d.active
			FROM disciplines d
			JOIN discipline_groups dg ON dg.discipline_id = d.id
			WHERE dg.group_id = ?
			ORDER BY d.name ASC`, id)
		if err != nil {
			return err
		}

		httpx.OK(w, disciplines)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/disciplines/{disciplineId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		disciplineID, ok := pathID(r, "disciplineId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		if _, found, err := db.One[int](s.db, "SELECT 1 FROM disciplines WHERE id = ?", disciplineID); err != nil {
			return err
		} else if !found {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		_, err = s.db.Exec("INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", disciplineID, id)
		if isUniqueErr(err, "discipline_groups.discipline_id", "discipline_groups.group_id") {
			httpx.Error(w, http.StatusConflict, "Already assigned")
			return nil
		}
		if err != nil {
			return err
		}

		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}/disciplines/{disciplineId}", func(w http.ResponseWriter, r *http.Request) error {
		id, ok := pathID(r, "id")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		_, found, err := db.One[int](s.db, "SELECT 1 FROM groups WHERE id = ?", id)
		if err != nil {
			return err
		}
		if !found {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}

		disciplineID, ok := pathID(r, "disciplineId")
		if !ok {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}

		if _, err := s.db.Exec("DELETE FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", disciplineID, id); err != nil {
			return err
		}

		httpx.Success(w)
		return nil
	})
}
