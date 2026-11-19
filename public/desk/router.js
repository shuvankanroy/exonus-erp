// Exonus ERP Router & Page System
// Modular, URL-hash driven, clean DOM updates without framework overhead

class DeskRouter {
  constructor() {
    this.routes = {};
    this.currentRoute = null;
    window.addEventListener('hashchange', () => this.handleRoute());
  }

  register(path, handler) {
    this.routes[path] = handler;
  }

  navigate(path) {
    window.location.hash = path;
  }

  handleRoute() {
    const hash = window.location.hash.slice(1) || 'stock/workspace';
    const [path, queryString] = hash.split('?');
    const params = new URLSearchParams(queryString || '');

    // Active link highlighting
    document.querySelectorAll('[data-route]').forEach(el => {
      if (el.getAttribute('data-route') === path) {
        el.classList.add('bg-blue-50', 'text-blue-700', 'font-bold', 'border-r-2', 'border-blue-600');
        el.classList.remove('text-slate-600');
      } else {
        el.classList.remove('bg-blue-50', 'text-blue-700', 'font-bold', 'border-r-2', 'border-blue-600');
        el.classList.add('text-slate-600');
      }
    });

    const handler = this.routes[path] || this.routes['404'] || this.routes['stock/workspace'];
    this.currentRoute = path;
    const container = document.getElementById('desk-content');
    if (container && handler) {
      handler(container, params);
    }
  }

  init() {
    this.handleRoute();
  }
}

window.router = new DeskRouter();
