/** Keep the device/visit context across local policy navigation. Capabilities
 * and identity data are never copied into URLs. */
export function captiveNavigationSearch(search: string): string {
  const input = new URLSearchParams(search);
  const output = new URLSearchParams();
  for (const key of ["id", "mac", "ap", "ssid", "url", "t", "site", "store"]) {
    const value = input.get(key);
    if (value) output.set(key, value);
  }
  const query = output.toString();
  return query ? "?" + query : "";
}
