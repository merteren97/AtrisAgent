/** Keep the mobile app at its intended scale while preserving one-finger scroll. */
export function installZoomLock(document: Document): void {
  const prevent = (event: Event) => event.preventDefault();
  const multitouch = (event: TouchEvent) => { if (event.touches.length > 1) event.preventDefault(); };
  document.addEventListener('touchstart', multitouch, { passive: false });
  document.addEventListener('touchmove', multitouch, { passive: false });
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(name, prevent, { passive: false });
  document.addEventListener('wheel', event => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });
  document.addEventListener('dblclick', event => {
    // Text selection must remain available in editable fields.
    if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable]')) event.preventDefault();
  });
}
