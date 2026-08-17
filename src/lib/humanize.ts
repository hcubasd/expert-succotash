// Table titles/headers and the map panel's own labels all get this: drop
// underscores, capitalize only the first letter of the first word.
export function humanize(name: string): string {
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
