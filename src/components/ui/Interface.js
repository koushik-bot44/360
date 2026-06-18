/**
 * Interface.js — 360 Virtual Tour custom UI layer.
 *
 * Drives the original welcome overlay, help panel, info card and keyboard
 * shortcuts. Kept fully decoupled from the Three.js engine: it only talks to
 * the DOM, dispatching clicks on the engine's own HUD buttons where needed.
 */
export default class Interface {
  constructor() {
    this.welcome = document.getElementById('welcome-overlay');
    this.helpPanel = document.getElementById('help-panel');
    this.infoCard = document.getElementById('info-card');

    this._bind();
  }

  _on(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  _bind() {
    // Welcome overlay
    this._on('welcome-start', () => this.dismissWelcome());
    this._on('welcome-help', () => { this.dismissWelcome(); this.open(this.helpPanel); });

    // HUD buttons
    this._on('help-button', () => this.toggle(this.helpPanel));
    this._on('info-button', () => this.toggle(this.infoCard));

    // Close buttons
    this._on('help-close', () => this.close(this.helpPanel));
    this._on('info-close', () => this.close(this.infoCard));

    // Click-outside to close panels
    [this.helpPanel, this.infoCard].forEach((panel) => {
      if (!panel) return;
      panel.addEventListener('click', (e) => { if (e.target === panel) this.close(panel); });
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => this._onKey(e));
  }

  _onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    switch (e.key) {
      case 'Escape':
        this.close(this.helpPanel);
        this.close(this.infoCard);
        break;
      case '?':
        this.toggle(this.helpPanel);
        break;
      case 'i': case 'I':
        this.toggle(this.infoCard);
        break;
      case 'v': case 'V':
        this._click('view-mode-button');
        break;
      case 'f': case 'F':
        this._click('full-screen-button');
        break;
      case 'ArrowRight':
        this._click('next-button');
        break;
      case 'ArrowLeft':
        this._click('prev-button');
        break;
      default:
        break;
    }
  }

  _click(id) {
    const el = document.getElementById(id);
    if (el) el.click();
  }

  open(panel) { if (panel) panel.classList.remove('hidden'); }
  close(panel) { if (panel) panel.classList.add('hidden'); }
  toggle(panel) { if (panel) panel.classList.toggle('hidden'); }

  dismissWelcome() {
    if (!this.welcome || this._welcomeGone) return;
    this._welcomeGone = true;
    this.welcome.classList.add('fade');
    setTimeout(() => this.welcome && this.welcome.classList.add('hidden'), 600);
  }
}
