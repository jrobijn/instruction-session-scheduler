package server

import (
	"cmp"
	"database/sql"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/db"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/httpx"
	"github.com/jrobijn/instruction-session-scheduler/backend/internal/queue"
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

// getGroup loads a group by id; it must exist.
func (s *Server) getGroup(id any) (Group, error) {
	g, _, err := db.One[Group](s.db, `
		SELECT id, name, color, is_default, active,
			new_member_priority, reactivated_member_priority, cooldown_member_priority
		FROM groups WHERE id = ?`, id)
	return g, err
}

type GroupWithCounts struct {
	Group
	MemberCount     int64 `db:"member_count" json:"member_count"`
	DisciplineCount int64 `db:"discipline_count" json:"discipline_count"`
}

func (s *Server) listGroups() ([]GroupWithCounts, error) {
	return db.Many[GroupWithCounts](s.db, `
		SELECT g.id, g.name, g.color, g.is_default, g.active,
			g.new_member_priority, g.reactivated_member_priority, g.cooldown_member_priority,
			(SELECT COUNT(*) FROM student_groups WHERE group_id = g.id) AS member_count,
			(SELECT COUNT(*) FROM discipline_groups WHERE group_id = g.id) AS discipline_count
		FROM groups g
		ORDER BY g.name ASC`)
}

// GroupRef names a group, e.g. one a discipline is linked to.
type GroupRef struct {
	ID   int64  `db:"id" json:"id"`
	Name string `db:"name" json:"name"`
}

// GroupSummary is a group as listed for a discipline.
type GroupSummary struct {
	ID        int64  `db:"id" json:"id"`
	Name      string `db:"name" json:"name"`
	IsDefault int64  `db:"is_default" json:"is_default"`
	Active    int64  `db:"active" json:"active"`
}

// GroupMember is a member in a group's queue, with what only the group page shows.
type GroupMember struct {
	queue.Member
	groupMemberExtras

	// Computed from the member and the extras.
	Position      *int64            `json:"queue_position"` // 1-based among active members; nil for inactive ones
	InviteNext    bool              `json:"invite_next"`
	QueueOverride *QueueOverride    `json:"queue_override"`
	BuddyGroup    *MemberBuddyGroup `json:"buddy_group"`
}

// groupMemberExtras is the per-student information only the group page needs.
type groupMemberExtras struct {
	StudentID         int64  `db:"student_id" json:"-"`
	ActiveInvitations int64  `db:"active_invitations" json:"active_invitations"`
	BuddyGroupID      *int64 `db:"buddy_group_id" json:"-"`
}

// QueueOverride says which event placed a member at the back of the queue.
type QueueOverride struct {
	Reason string `json:"reason"` // joined, reactivated or cooldown
	At     string `json:"at"`
}

type MemberBuddyGroup struct {
	ID      int64   `json:"id"`
	Name    string  `json:"name"`
	Buddies []Buddy `json:"buddies"` // the other members
}

type Buddy struct {
	ID        int64   `db:"id" json:"id"`
	FirstName string  `db:"first_name" json:"first_name"`
	LastName  string  `db:"last_name" json:"last_name"`
	GroupID   *int64  `db:"group_id" json:"group_id"`
	GroupName *string `db:"group_name" json:"group_name"`
}

func (s *Server) groupRoutes() {
	s.adminRoute("GET /api/groups", func(w http.ResponseWriter, r *http.Request) error {
		groups, err := s.listGroups()
		if err != nil {
			return err
		}
		httpx.OK(w, groups)
		return nil
	})

	s.adminRoute("GET /api/groups/export", func(w http.ResponseWriter, r *http.Request) error {
		groups, err := s.listGroups()
		if err != nil {
			return err
		}
		lines := make([]string, len(groups))
		for i, g := range groups {
			lines[i] = csvRow(g.Name, strconv.FormatInt(g.IsDefault, 10), strconv.FormatInt(g.Active, 10))
		}
		writeCSV(w, "groups.csv", "name,is_default,active", lines)
		return nil
	})

	s.adminRoute("POST /api/groups/import", func(w http.ResponseWriter, r *http.Request) error {
		lines, ok := readCSVImport(w, r)
		if !ok {
			return nil
		}
		nameIdx := indexOf(csvHeader(lines[0]), "name")
		if nameIdx == -1 {
			httpx.Error(w, http.StatusBadRequest, "CSV must contain a name column")
			return nil
		}
		result := importResult{Errors: []string{}}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			for i := 1; i < len(lines); i++ {
				name := field(parseCSVLine(lines[i]), nameIdx)
				if name == "" {
					result.Errors = append(result.Errors, fmt.Sprintf("Row %d: missing name", i+1))
					result.Skipped++
					continue
				}
				var id int64
				switch err := tx.QueryRow("SELECT id FROM groups WHERE name = ?", name).Scan(&id); err {
				case nil:
					result.Skipped++
				case sql.ErrNoRows:
					_, err := tx.Exec("INSERT INTO groups (name) VALUES (?)", name)
					switch {
					case isUniqueErr(err):
						result.Errors = append(result.Errors, fmt.Sprintf("Row %d: A group with this name already exists", i+1))
						result.Skipped++
					case err != nil:
						return err
					default:
						result.Imported++
					}
				default:
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		httpx.OK(w, result)
		return nil
	})

	s.adminRoute("POST /api/groups", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Name  string `json:"name"`
			Color string `json:"color"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Name == "" {
			httpx.Error(w, http.StatusBadRequest, "Name is required")
			return nil
		}
		if in.Color == "" {
			in.Color = "#3b82f6"
		}
		res, err := s.db.Exec("INSERT INTO groups (name, color, new_member_priority, reactivated_member_priority, cooldown_member_priority) VALUES (?, ?, 'back', 'back', 'back')",
			in.Name, in.Color)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A group with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := s.getGroup(lastID(res))
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
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
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
		_, err := s.db.Exec(`
			UPDATE groups SET
				name = COALESCE(?, name),
				active = COALESCE(?, active),
				color = COALESCE(?, color),
				new_member_priority = COALESCE(?, new_member_priority),
				reactivated_member_priority = COALESCE(?, reactivated_member_priority),
				cooldown_member_priority = COALESCE(?, cooldown_member_priority)
			WHERE id = ?`,
			in.Name, in.Active, in.Color,
			in.NewMemberPriority, in.ReactivatedMemberPriority, in.CooldownMemberPriority, id)
		if isUniqueErr(err) {
			httpx.Error(w, http.StatusConflict, "A group with this name already exists")
			return nil
		}
		if err != nil {
			return err
		}
		row, err := s.getGroup(id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if s.exists("SELECT 1 FROM timetable_groups WHERE group_id = ?", id) {
			httpx.Error(w, http.StatusBadRequest, "Cannot delete a group that is assigned to timetables")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM groups WHERE id = ?", id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/set-default", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
			if _, err := tx.Exec("UPDATE groups SET is_default = 0 WHERE is_default = 1"); err != nil {
				return err
			}
			_, err := tx.Exec("UPDATE groups SET is_default = 1 WHERE id = ?", id)
			return err
		})
		if err != nil {
			return err
		}
		row, err := s.getGroup(id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("POST /api/groups/{id}/unset-default", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("UPDATE groups SET is_default = 0 WHERE id = ?", id); err != nil {
			return err
		}
		row, err := s.getGroup(id)
		if err != nil {
			return err
		}
		httpx.OK(w, row)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/members", s.handleGroupMembers)

	s.adminRoute("POST /api/groups/{id}/members", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			StudentID int64 `json:"student_id"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		studentID := in.StudentID
		if studentID == 0 {
			httpx.Error(w, http.StatusBadRequest, "student_id is required")
			return nil
		}
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if !s.exists("SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL", studentID) {
			httpx.Error(w, http.StatusNotFound, "Student not found")
			return nil
		}
		err := s.db.InTx(func(tx *sqlx.Tx) error {
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

	// Toggle "invite next": the member jumps the queue until they get a counted invitation.
	s.adminRoute("PUT /api/groups/{id}/members/{studentId}/invite-next", func(w http.ResponseWriter, r *http.Request) error {
		type request struct {
			Enabled *bool `json:"enabled"`
		}
		in, ok := decode[request](w, r)
		if !ok {
			return nil
		}
		if in.Enabled == nil {
			httpx.Error(w, http.StatusBadRequest, "enabled (boolean) is required")
			return nil
		}
		value := "NULL"
		if *in.Enabled {
			value = "datetime('now')"
		}
		res, err := s.db.Exec("UPDATE student_groups SET invite_next_at = "+value+" WHERE group_id = ? AND student_id = ?",
			r.PathValue("id"), r.PathValue("studentId"))
		if err != nil {
			return err
		}
		if changes(res) == 0 {
			httpx.Error(w, http.StatusNotFound, "Member not found")
			return nil
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("DELETE /api/groups/{id}/members/{studentId}", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM student_groups WHERE student_id = ? AND group_id = ?", r.PathValue("studentId"), id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})

	s.adminRoute("GET /api/groups/{id}/non-members", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if q == "" {
			httpx.OK(w, []any{})
			return nil
		}
		like := "%" + q + "%"
		students, err := db.Many[StudentSearchResult](s.db, `
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
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
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
		id, disciplineID := r.PathValue("id"), r.PathValue("disciplineId")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if !s.exists("SELECT 1 FROM disciplines WHERE id = ?", disciplineID) {
			httpx.Error(w, http.StatusNotFound, "Discipline not found")
			return nil
		}
		_, err := s.db.Exec("INSERT INTO discipline_groups (discipline_id, group_id) VALUES (?, ?)", disciplineID, id)
		if isUniqueErr(err) {
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
		id := r.PathValue("id")
		if !s.exists("SELECT 1 FROM groups WHERE id = ?", id) {
			httpx.Error(w, http.StatusNotFound, "Group not found")
			return nil
		}
		if _, err := s.db.Exec("DELETE FROM discipline_groups WHERE discipline_id = ? AND group_id = ?", r.PathValue("disciplineId"), id); err != nil {
			return err
		}
		httpx.Success(w)
		return nil
	})
}

// handleGroupMembers lists a group's members in queue order, with queue position, override
// reason and buddy group details.
func (s *Server) handleGroupMembers(w http.ResponseWriter, r *http.Request) error {
	groupID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || !s.exists("SELECT 1 FROM groups WHERE id = ?", groupID) {
		httpx.Error(w, http.StatusNotFound, "Group not found")
		return nil
	}
	queueMembers, err := queue.LoadMembers(s.db)
	if err != nil {
		return err
	}
	extras, err := db.Many[groupMemberExtras](s.db, `
		SELECT sg.student_id, bgm.buddy_group_id,
			(SELECT COUNT(*) FROM invitations i
				JOIN training_sessions ts ON ts.id = i.session_id
				WHERE i.student_id = sg.student_id AND i.status IN ('confirmed', 'invited', 'scheduled')
					AND ts.status != 'completed') AS active_invitations
		FROM student_groups sg
		LEFT JOIN buddy_group_members bgm ON bgm.student_id = sg.student_id
		WHERE sg.group_id = ?`, groupID)
	if err != nil {
		return err
	}
	extrasByID := map[int64]groupMemberExtras{}
	for _, x := range extras {
		extrasByID[x.StudentID] = x
	}
	// Active members first, in the order the scheduler uses: ties are broken with the next
	// session still to be sent as the seed, so the overview shows that session's order (seed 0
	// without one).
	seed, _, err := db.One[int64](s.db, `
		SELECT id FROM training_sessions
		WHERE status IN ('draft', 'scheduled') AND date >= ?
		ORDER BY date LIMIT 1`, nowFunc().In(s.clubLocation()).Format(time.DateOnly))
	if err != nil {
		return err
	}
	inGroup := slices.DeleteFunc(queueMembers, func(m queue.Member) bool { return m.GroupID != groupID })
	queue.Sort(inGroup, seed)
	members := make([]GroupMember, len(inGroup))
	for i, m := range inGroup {
		members[i] = GroupMember{Member: m, groupMemberExtras: extrasByID[m.ID]}
	}
	slices.SortStableFunc(members, func(a, b GroupMember) int { return cmp.Compare(b.Active, a.Active) })

	// Buddy group names are built from member first names (matches the students list).
	type buddyRow struct {
		BuddyGroupID int64 `db:"buddy_group_id"`
		Buddy
	}
	buddies, err := db.Many[buddyRow](s.db, `
		SELECT bgm.student_id AS id, bgm.buddy_group_id, s.first_name, s.last_name, sg.group_id, g.name AS group_name
		FROM buddy_group_members bgm
		JOIN students s ON s.id = bgm.student_id AND s.deleted_at IS NULL
		LEFT JOIN student_groups sg ON sg.student_id = s.id
		LEFT JOIN groups g ON g.id = sg.group_id`)
	if err != nil {
		return err
	}
	buddiesByGroup := map[int64][]Buddy{}
	for _, b := range buddies {
		buddiesByGroup[b.BuddyGroupID] = append(buddiesByGroup[b.BuddyGroupID], b.Buddy)
	}

	position := int64(0)
	for i := range members {
		m := &members[i]
		if m.QueueReason != nil {
			m.QueueOverride = &QueueOverride{Reason: *m.QueueReason, At: m.QueueAt}
		}

		if m.Active != 0 {
			position++
			p := position
			m.Position = &p
		}
		m.InviteNext = m.InviteNextPendingSince != nil

		if m.BuddyGroupID != nil {
			group := buddiesByGroup[*m.BuddyGroupID]
			names := make([]string, len(group))
			others := []Buddy{}
			for j, b := range group {
				names[j] = b.FirstName
				if b.ID != m.ID {
					others = append(others, b)
				}
			}
			m.BuddyGroup = &MemberBuddyGroup{ID: *m.BuddyGroupID, Name: strings.Join(names, " & "), Buddies: others}
		}
	}
	httpx.OK(w, members)
	return nil
}
