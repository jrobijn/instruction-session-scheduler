package email

import (
	"strings"
)

// Mirrors the light theme in frontend/src/styles/tokens.css (email clients don't support CSS variables).
var theme = struct {
	page, surface, sunken, border, borderStrong, text, muted, gunmetal, onGunmetal string
	accent, accentText, accentContrast, success, danger                            string
	fontBody, fontDisplay, fontMono                                                string
}{
	page: "#e9ebec", surface: "#ffffff", sunken: "#f6f7f7", border: "#c9cdd0", borderStrong: "#a9afb4",
	text: "#1d2124", muted: "#5d656b", gunmetal: "#262a2e", onGunmetal: "#e6e8ea",
	accent: "#165b92", accentText: "#165b92", accentContrast: "#ffffff", success: "#3f6a2e", danger: "#a3141c",
	fontBody:    "'Barlow', 'Helvetica Neue', Arial, sans-serif",
	fontDisplay: "'Barlow Semi Condensed', 'Barlow', 'Helvetica Neue', Arial, sans-serif",
	fontMono:    "'IBM Plex Mono', Menlo, Consolas, monospace",
}

type detailRow struct {
	label, value string
	mono         bool
}

func renderLayout(locale, title, clubName, content string) string {
	return `<!DOCTYPE html>
<html lang="` + escape(locale) + `">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>` + escape(title) + `</title>
</head>
<body style="margin: 0; padding: 0; background: ` + theme.page + `;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ` + theme.page + `;">
  <tr>
    <td align="center" style="padding: 24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background: ` + theme.surface + `; border: 1px solid ` + theme.border + `; border-radius: 3px;">
        <tr>
          <td style="background: ` + theme.gunmetal + `; border-bottom: 3px solid ` + theme.accent + `; border-radius: 3px 3px 0 0; padding: 16px 24px; font-family: ` + theme.fontDisplay + `; font-size: 18px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ` + theme.onGunmetal + `;">
            ` + escape(clubName) + `
          </td>
        </tr>
        <tr>
          <td style="padding: 28px 24px; font-family: ` + theme.fontBody + `; font-size: 15px; line-height: 1.5; color: ` + theme.text + `;">
            ` + content + `
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

func renderHeading(text string) string {
	return `<h1 style="margin: 0 0 16px; font-family: ` + theme.fontDisplay + `; font-size: 22px; font-weight: 700; line-height: 1.3; letter-spacing: 0.01em; color: ` + theme.text + `;">` + escape(text) + `</h1>`
}

// renderParagraph expects html to be escaped already.
func renderParagraph(html string) string {
	return `<p style="margin: 0 0 16px;">` + html + `</p>`
}

func renderDetails(rows []detailRow, tone string) string {
	toneColor := theme.success
	if tone == "danger" {
		toneColor = theme.danger
	}
	var rowsHTML strings.Builder
	for _, r := range rows {
		font, size := theme.fontBody, "15px"
		if r.mono {
			font, size = theme.fontMono, "14px"
		}
		rowsHTML.WriteString(`
      <tr>
        <td style="padding: 4px 16px 4px 0; white-space: nowrap; vertical-align: baseline; font-family: ` + theme.fontDisplay + `; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ` + theme.muted + `;">` + escape(strings.TrimSuffix(r.label, ":")) + `</td>
        <td style="padding: 4px 0; vertical-align: baseline; font-family: ` + font + `; font-size: ` + size + `; color: ` + theme.text + `;">` + escape(r.value) + `</td>
      </tr>`)
	}
	return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 20px; background: ` + theme.sunken + `; border: 1px solid ` + theme.border + `; border-left: 3px solid ` + toneColor + `; border-radius: 2px;">
      <tr>
        <td style="padding: 12px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">` + rowsHTML.String() + `
          </table>
        </td>
      </tr>
    </table>`
}

func renderButton(url, label, variant string) string {
	background, border, color := theme.sunken, theme.borderStrong, theme.text
	if variant == "primary" {
		background, border, color = theme.accent, theme.accentText, theme.accentContrast
	}
	return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
      <tr>
        <td style="background: ` + background + `; border: 1px solid ` + border + `; border-radius: 2px;">
          <a href="` + escape(url) + `" style="display: inline-block; padding: 12px 24px; font-family: ` + theme.fontBody + `; font-size: 15px; font-weight: 600; color: ` + color + `; text-decoration: none;">` + escape(label) + `</a>
        </td>
      </tr>
    </table>`
}

func renderCopyLink(label, url string) string {
	return `<p style="margin: 0 0 20px; font-size: 13px; color: ` + theme.muted + `; word-break: break-all;">` + escape(label) + ` <a href="` + escape(url) + `" style="color: ` + theme.accentText + `;">` + escape(url) + `</a></p>`
}

func renderSignoff(closing, clubName string) string {
	return `<p style="margin: 0; padding-top: 16px; border-top: 1px solid ` + theme.border + `;">` + escape(closing) + `<br/><strong>` + escape(clubName) + `</strong></p>`
}

func sessionRows(s Strings, formattedDate, startTime, discipline string) []detailRow {
	rows := []detailRow{
		{label: s.DateLabel, value: formattedDate},
		{label: s.TimeLabel, value: startTime, mono: true},
	}
	if discipline != "" {
		rows = append(rows, detailRow{label: s.DisciplineLabel, value: discipline})
	}
	return rows
}
