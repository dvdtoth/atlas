import {
  telemetry,
  savedConsent,
  setAnalyticsConsent,
  savedRepositoryConsent,
  setRepositoryConsent,
} from '../shared/telemetry.mjs';

// Fixed app pages only: never read document.title, query parameters or source URLs.
telemetry.pageview();
document
  .querySelector('.github-link')
  ?.addEventListener('click', () => telemetry.track('github_clicked'));

const usage = document.getElementById('analytics-consent');
const repositories = document.getElementById('analytics-repositories');
function refresh() {
  if (!usage || !repositories) return;
  usage.checked = savedConsent();
  usage.disabled = !telemetry.configured || telemetry.privacyBlocked;
  repositories.checked = savedRepositoryConsent();
  repositories.disabled = !telemetry.allowed;
  document.getElementById('analytics-note').textContent = telemetry.privacyBlocked
    ? 'Analytics disabled by your browser privacy preference.'
    : telemetry.configured
      ? 'Optional Umami analytics. Public repository names are shared only with the second option. No code, local file names, or search text.'
      : 'Analytics are off. This installation has no analytics endpoint configured.';
}
usage?.addEventListener('change', () => {
  setAnalyticsConsent(usage.checked);
  refresh();
  telemetry.pageview();
});
repositories?.addEventListener('change', () => {
  setRepositoryConsent(repositories.checked);
  refresh();
});
window.addEventListener('storage', refresh);
refresh();
