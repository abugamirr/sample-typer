/* App.jsx talks to `window.storage.{get,set,delete}` expecting some host
   environment to provide it. Running standalone (npm run dev / build),
   nothing does — so back it with localStorage instead. */
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key);
      return value === null ? null : { value };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { ok: true };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { ok: true };
    },
  };
}
