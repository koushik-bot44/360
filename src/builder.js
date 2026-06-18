import './builder.css';
import Builder from './builder/Builder';

console.log('🛠️ 360 Virtual Tour — Builder');

function boot() { window.__builder__ = new Builder(); }

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
