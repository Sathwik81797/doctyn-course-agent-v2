// @ts-check
// Key validation shared by every storage driver.

/** Keys are built by the server from ids; this guards the drivers against odd input anyway. @param {string} key */
export function assertKey(key) {
  if (!key || key.length > 600 || key.startsWith("/") || key.split("/").some((s) => s === ".." || s === "." || s === "") || /[\\\0]/.test(key)) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}
