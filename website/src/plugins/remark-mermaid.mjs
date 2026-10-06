// Remark plugin: turns ```mermaid fences into <pre class="mermaid"> so Shiki leaves them alone;
// the docs page loads mermaid in the browser only when such a block exists.
import { visit } from 'unist-util-visit';

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default function remarkMermaid() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (node.lang !== 'mermaid' || !parent) return;
      parent.children[index] = {
        type: 'html',
        value: `<pre class="mermaid">${escapeHtml(node.value)}</pre>`,
      };
    });
  };
}
