const m = require('msmc');
console.log('keys', Object.keys(m));
console.log('Auth', m.Auth);
console.log('default', m.default ? Object.keys(m.default) : undefined);
