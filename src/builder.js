import './builder.css';
import Builder from './builder/Builder';

console.log('🛠️ 360 Virtual Tour — Builder');

function boot() { window.__builder__ = new Builder(); }

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// Register the service worker → installable PWA + offline app shell on the phone.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
