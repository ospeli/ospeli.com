// Diagnostics: the screens. Skeleton; the builder replaces this.
export async function render(el) {
  const p = document.createElement('p');
  p.textContent = 'Diagnostics: being built.';
  el.replaceChildren(p);
}
