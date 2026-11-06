package email

import "fmt"

// Strings holds the translated email texts.
// Format strings take their arguments in the order of the TS functions' parameters.
type Strings struct {
	Greeting                 string // name
	InvitationBody           string // clubName, date
	InvitationCta            string
	RespondButton            string
	CopyLink                 string
	BestRegards              string
	ConfirmationBody         string // clubName
	DateLabel                string
	TimeLabel                string
	DisciplineLabel          string
	CancelExplanation        string
	CancelButton             string
	SeeYou                   string
	ConfirmationSubject      string // clubName
	CancellationBody         string // clubName
	CancellationSubject      string // clubName
	InvitationSubject        string // clubName
	AdminCancellationBody    string // clubName
	AdminCancellationSubject string // clubName
}

var translations = map[string]Strings{
	"en": {
		Greeting:                 "Hi %s,",
		InvitationBody:           "You have been invited to an instruction session at <strong>%s</strong> on <strong>%s</strong>.",
		InvitationCta:            "Please click the link below to confirm or decline your attendance:",
		RespondButton:            "Respond to Invitation",
		CopyLink:                 "Or copy this link:",
		BestRegards:              "Best regards,",
		ConfirmationBody:         "Your attendance has been confirmed for the instruction session at <strong>%s</strong>.",
		DateLabel:                "Date:",
		TimeLabel:                "Time:",
		DisciplineLabel:          "Discipline:",
		CancelExplanation:        "If you can no longer attend, please cancel your participation using the link below so another student can take your place:",
		CancelButton:             "Cancel Participation",
		SeeYou:                   "See you at the training!",
		ConfirmationSubject:      "Instruction Session Confirmed — %s",
		CancellationBody:         "Your participation in the instruction session at <strong>%s</strong> has been cancelled.",
		CancellationSubject:      "Instruction Session Cancelled — %s",
		InvitationSubject:        "Instruction Session Invitation — %s",
		AdminCancellationBody:    "Your invitation for the instruction session at <strong>%s</strong> has been withdrawn by the organiser.",
		AdminCancellationSubject: "Instruction Session Invitation Withdrawn — %s",
	},
	"nl": {
		Greeting:                 "Hoi %s,",
		InvitationBody:           "Je bent uitgenodigd voor een instructiesessie bij <strong>%s</strong> op <strong>%s</strong>.",
		InvitationCta:            "Klik op de link hieronder om je aanwezigheid te bevestigen of af te wijzen:",
		RespondButton:            "Reageer op uitnodiging",
		CopyLink:                 "Of kopieer deze link:",
		BestRegards:              "Met vriendelijke groet,",
		ConfirmationBody:         "Je aanwezigheid is bevestigd voor de instructiesessie bij <strong>%s</strong>.",
		DateLabel:                "Datum:",
		TimeLabel:                "Tijd:",
		DisciplineLabel:          "Discipline:",
		CancelExplanation:        "Als je toch niet kunt komen, annuleer dan je deelname via de link hieronder zodat een andere leerling jouw plek kan innemen:",
		CancelButton:             "Deelname annuleren",
		SeeYou:                   "Tot bij de training!",
		ConfirmationSubject:      "Instructiesessie bevestigd — %s",
		CancellationBody:         "Je deelname aan de instructiesessie bij <strong>%s</strong> is geannuleerd.",
		CancellationSubject:      "Instructiesessie geannuleerd — %s",
		InvitationSubject:        "Uitnodiging instructiesessie — %s",
		AdminCancellationBody:    "Je uitnodiging voor de instructiesessie bij <strong>%s</strong> is ingetrokken door de organisatie.",
		AdminCancellationSubject: "Instructiesessie uitnodiging ingetrokken — %s",
	},
}

// For returns the strings for locale, falling back to English.
func For(locale string) Strings {
	if s, ok := translations[locale]; ok {
		return s
	}
	return translations["en"]
}

func f(format string, a ...any) string { return fmt.Sprintf(format, a...) }

var (
	enWeekdays = [...]string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}
	enMonths   = [...]string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}
	nlWeekdays = [...]string{"zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"}
	nlMonths   = [...]string{"januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"}
)
