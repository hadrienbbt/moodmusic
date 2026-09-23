// The pages the server renders itself, during the login (plan §4.3, §4.5):
// plain HTML in French, no script, and a link to try again.
export const LOGIN_FAILED = 'Connexion impossible, réessaie.'
export const NOT_ALLOWLISTED = "Compte non autorisé : Moodmusic est une application Spotify en mode développement limitée à 5 utilisateurs. Demande à Hadrien d'ajouter ton compte, puis reconnecte-toi."

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export const page = message => `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Moodmusic</title></head>
<body><main><h1>Moodmusic</h1><p>${escapeHtml(message)}</p><p><a href="/auth/login">Réessayer</a></p></main></body>
</html>
`
