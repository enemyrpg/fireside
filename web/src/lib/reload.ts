/** Reloads the dashboard. Its own module, so tests can see that it was called (and how often). */
export function reloadPage(): void {
  window.location.reload();
}
