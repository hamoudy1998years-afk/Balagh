if (typeof DOMException === 'undefined') {
  global.DOMException = class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name || 'Error';
    }
  };
}

const { registerRootComponent } = require('expo');
const App = require('./App').default;

registerRootComponent(App);