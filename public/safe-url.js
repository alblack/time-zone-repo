// Returns the normalized URL if it is http(s), otherwise null.
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

if (typeof module !== 'undefined') module.exports = { safeUrl };
