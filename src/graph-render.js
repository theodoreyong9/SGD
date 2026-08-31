// Minimal force-directed layout, dependency-free (fine for hundreds of nodes;
// swap for a proper spatial index if the graph grows past a few thousand).
//
// Navigation à deux niveaux : "paysage" (tout le graphe, par défaut) et
// "région" (un domaine sémantique mis en avant, le reste estompé). Cliquer
// un nœud entre dans sa région ; le bouton de retour dans l'UI en sort.
// Volontairement PAS un vrai niveau "sujet" (sous-graphe recalculé) —
// voir README, section "Limites connues" — ceci reste un filtre visuel
// sur le graphe existant, pas une nouvelle structure de données.

const COLORS = {
  edge: {
    contredit: "rgba(166, 86, 75, 0.55)",
    alternative_a: "rgba(166, 86, 75, 0.4)",
    implique: "rgba(199, 154, 59, 0.45)",
    complete: "rgba(92, 122, 153, 0.45)",
    default: "rgba(232, 227, 216, 0.15)",
  },
  node: "rgba(199, 154, 59, 0.85)",
  nodeHighlight: "#c79a3b",
  nodeDimmed: "rgba(199, 154, 59, 0.18)",
  text: "rgba(232, 227, 216, 0.6)",
  textDimmed: "rgba(232, 227, 216, 0.15)",
};

const DIMMED_ALPHA = 0.12;

export function createGraphRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  let width, height;
  let nodes = [];
  let edges = [];
  let highlightedId = null;
  let focusDomain = null;
  let animationFrame = null;
  let nodeClickHandler = null;

  function resize() {
    width = canvas.width = window.innerWidth * devicePixelRatio;
    height = canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  function setData(graph) {
    const existingPositions = new Map(nodes.map((n) => [n.id, n]));
    nodes = graph.nodes.map((n) => {
      const prev = existingPositions.get(n.id);
      return {
        ...n,
        x: prev?.x ?? window.innerWidth / 2 + (Math.random() - 0.5) * 200,
        y: prev?.y ?? window.innerHeight / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        radius: 4 + Math.sqrt(n.stats.contribution) * 6 + n.stats.novelty * 6,
      };
    });
    edges = graph.edges
      .map((e) => ({
        ...e,
        sourceNode: nodes.find((n) => n.id === e.source),
        targetNode: nodes.find((n) => n.id === e.target),
      }))
      .filter((e) => e.sourceNode && e.targetNode);
  }

  function setHighlight(id) {
    highlightedId = id;
  }

  // setFocusDomain(domain | null): "région" view. Nodes outside `domain`
  // are dimmed rather than removed, so the force simulation keeps running
  // on the whole graph and nothing jumps when entering/leaving a region.
  function setFocusDomain(domain) {
    focusDomain = domain || null;
  }

  function nodeAt(clientX, clientY) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = clientX - n.x;
      const dy = clientY - n.y;
      if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
    }
    return null;
  }

  function onNodeClick(handler) {
    nodeClickHandler = handler;
  }

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const node = nodeAt(x, y);
    nodeClickHandler?.(node);
  });

  canvas.addEventListener(
    "mousemove",
    (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      canvas.style.cursor = nodeAt(x, y) ? "pointer" : "default";
    },
    { passive: true }
  );

  function tick() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    for (const n of nodes) {
      // gentle pull to center so the graph doesn't drift off-screen
      n.vx += (cx - n.x) * 0.0006;
      n.vy += (cy - n.y) * 0.0006;

      // repulsion between all node pairs
      for (const other of nodes) {
        if (other === n) continue;
        const dx = n.x - other.x;
        const dy = n.y - other.y;
        const distSq = Math.max(dx * dx + dy * dy, 100);
        const force = 1800 / distSq;
        n.vx += (dx / Math.sqrt(distSq)) * force;
        n.vy += (dy / Math.sqrt(distSq)) * force;
      }
    }

    // attraction along edges
    for (const e of edges) {
      const dx = e.targetNode.x - e.sourceNode.x;
      const dy = e.targetNode.y - e.sourceNode.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetDist = 140;
      const force = (dist - targetDist) * 0.003 * Math.min(e.weight, 5);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      e.sourceNode.vx += fx;
      e.sourceNode.vy += fy;
      e.targetNode.vx -= fx;
      e.targetNode.vy -= fy;
    }

    for (const n of nodes) {
      n.vx *= 0.85;
      n.vy *= 0.85;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  function inFocus(node) {
    return !focusDomain || node.semantic.domain === focusDomain;
  }

  function draw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (const e of edges) {
      const dimmed = focusDomain && !(inFocus(e.sourceNode) && inFocus(e.targetNode));
      ctx.strokeStyle = COLORS.edge[e.type] || COLORS.edge.default;
      ctx.lineWidth = Math.min(1 + e.weight * 0.4, 3);
      ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
      ctx.beginPath();
      ctx.moveTo(e.sourceNode.x, e.sourceNode.y);
      ctx.lineTo(e.targetNode.x, e.targetNode.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const n of nodes) {
      const isHighlighted = n.id === highlightedId;
      const dimmed = focusDomain && !inFocus(n) && !isHighlighted;

      ctx.beginPath();
      ctx.arc(n.x, n.y, isHighlighted ? n.radius * 1.6 : n.radius, 0, Math.PI * 2);
      ctx.fillStyle = isHighlighted ? COLORS.nodeHighlight : dimmed ? COLORS.nodeDimmed : COLORS.node;
      ctx.globalAlpha = dimmed ? DIMMED_ALPHA : isHighlighted ? 1 : 0.75;
      ctx.fill();
      ctx.globalAlpha = 1;

      if ((isHighlighted || n.radius > 8) && !dimmed) {
        ctx.fillStyle = COLORS.text;
        ctx.font = "12px 'IBM Plex Sans', sans-serif";
        ctx.fillText(truncate(n.text, 40), n.x + n.radius + 6, n.y + 4);
      }
    }
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  function loop() {
    tick();
    draw();
    animationFrame = requestAnimationFrame(loop);
  }

  loop();

  return {
    setData,
    setHighlight,
    setFocusDomain,
    onNodeClick,
    destroy: () => cancelAnimationFrame(animationFrame),
  };
}
