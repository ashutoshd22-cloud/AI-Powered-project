// Applies the saved theme before first paint to avoid a light/dark flash.
// Kept as an external file so the Content-Security-Policy can forbid inline scripts.
;(function () {
  try {
    var pref = localStorage.getItem('lifeos:theme') || 'system'
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
  } catch (e) {
    /* storage unavailable: fall back to light */
  }
})()
