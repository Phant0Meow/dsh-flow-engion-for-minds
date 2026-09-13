// ═══════════════════════════════════════════════════════════════
// ═══ useWorkflowRuntime.jsx ═══
// ═══════════════════════════════════════════════════════════════

import { useCallback, useRef, useState } from 'react';
import { eid, getNodeSize, smartBezier, SPW, SPH, SINK_ONLY } from './common';

function useCanvasInteraction({
  cvRef,
  nodesRef,
  setNodes,
  edges,
  setEdges,
  scale,
  setScale,
  pan,
  setPan,
  setSel,
  addNode,
  addModuleNode,
  addSpecialNode,
  addPositionNode,
  lib,
}) {
  const [drag, setDrag] = useState(null);
  const [conn, setConn] = useState(null);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, px: 0, py: 0 });
  const isMouseDownRef = useRef(false);
  const isDraggingRef = useRef(false);
  const mouseDownPosRef = useRef({ x: 0, y: 0 });

  // Node map helper
  const nm = new Map((nodesRef.current || []).map((n) => [n.id, n]));

  // Convert client coords to canvas coords
  const xy = useCallback(
    (e) => {
      const r = cvRef.current?.getBoundingClientRect();
      if (!r) return [0, 0];
      return [
        (e.clientX - r.left - pan.x) / scale,
        (e.clientY - r.top - pan.y) / scale,
      ];
    },
    [cvRef, pan, scale]
  );

  // Mouse move handler
  const onMM = useCallback(
    (e) => {
      // 节点拖拽、连线时，无需检查 isMouseDownRef
      if (drag) {
        setNodes((p) => {
          const draggedNode = p.find((n) => n.id === drag.id);
          if (!draggedNode) return p;
          const newX = drag.ox + (e.clientX - drag.sx) / scale;
          const newY = drag.oy + (e.clientY - drag.sy) / scale;
          return p.map((n) => {
            if (n.id === drag.id) {
              return { ...n, x: newX, y: newY };
            }
// 拖拽 FOR 节点 → 联动 for_out 小圆点
if (draggedNode.specialType === 'FOR' && n.type === 'for_out' && n.id === draggedNode.forOutNodeId) {
  return { ...n, x: newX + SPW - 22, y: newY + (SPH - 22) / 2 };
}
// 拖拽 for_out 小圆点 → 联动 FOR 节点
if (draggedNode.type === 'for_out' && n.id === draggedNode.forNodeId) {
  return { ...n, x: newX - SPW + 22, y: newY - (SPH - 22) / 2 };
}
// par_out 不做任何联动（自由移动）
// 注意：par_out 不做任何联动，自由移动
            return n;
          });
        });
        return;
      }
      if (conn) {
        const [cx, cy] = xy(e);
        setConn((p) => ({ ...p, mx: cx, my: cy }));
        return;
      }

      // 画布平移：必须按下鼠标才开始判断
      if (!isMouseDownRef.current) return;

      if (!isPanning) {
        const dx = e.clientX - mouseDownPosRef.current.x;
        const dy = e.clientY - mouseDownPosRef.current.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          setIsPanning(true);
          isDraggingRef.current = true;
        }
        return;
      }
      setPan({
        x: panStart.px + e.clientX - panStart.x,
        y: panStart.py + e.clientY - panStart.y,
      });
    },
    [drag, conn, xy, isPanning, panStart, scale]
  );

  // Wheel handler (zoom/pan)
  const handleWheel = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent?.stopImmediatePropagation?.();

      if (e.ctrlKey || e.metaKey) {
        const rect = cvRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - pan.x) / scale;
        const worldY = (mouseY - pan.y) / scale;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.min(3, Math.max(0.2, scale * delta));
        const newPanX = mouseX - worldX * newScale;
        const newPanY = mouseY - worldY * newScale;
        setScale(newScale);
        setPan({ x: newPanX, y: newPanY });
      } else {
        setPan((prev) => ({
          x: prev.x - e.deltaX,
          y: prev.y - e.deltaY,
        }));
      }
    },
    [scale, pan]
  );

  // Mouse up handler
  const onMU = useCallback(() => {
    if (isMouseDownRef.current && !isDraggingRef.current) {
      setSel(null);
    }
    setDrag(null);
    setConn(null);
    setIsPanning(false);
    isDraggingRef.current = false;
    isMouseDownRef.current = false;
  }, []);

  // Canvas mouse down (for panning)
  const onCanvasDown = useCallback(
    (e) => {
      if (!e.target?.dataset?.canvasBg && e.target !== cvRef.current) return;
      if (drag || isPanning || conn) {
        setDrag(null);
        setIsPanning(false);
        setConn(null);
        isDraggingRef.current = false;
        isMouseDownRef.current = false;
        return;
      }
      if (e.button === 0 || e.button === 1) {
        isMouseDownRef.current = true;
        mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
        setPanStart({ x: e.clientX, y: e.clientY, px: pan.x, py: pan.y });
        e.preventDefault();
      }
    },
    [pan, drag, isPanning, conn]
  );

  // Port handlers
  function handlePortDown(e, nodeId, portDir, portX, portY) {
    const node = nm.get(nodeId);
    if (node?.type === 'special' && SINK_ONLY.has(node.specialType) && portDir !== 'for_out') return;
    const [cx, cy] = xy(e);
    let srcX = portX, srcY = portY;
    if (srcX === undefined || srcY === undefined) {
      const size = getNodeSize(node);
      srcX = node.x + size.w / 2;
      srcY = node.y + size.h / 2;
    }
    setConn({ srcId: nodeId, srcDir: portDir, mx: cx, my: cy, srcX, srcY });
  }

  function handlePortUp(e, nodeId, portDir) {
    if (!conn) return;
    if (conn.srcId === nodeId) {
      if (!edges.some((ed) => ed.src === nodeId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: nodeId, tgt: nodeId, cond: '', isSelfLoop: true },
        ]);
      }
      setConn(null);
    } else {
      if (!edges.some((ed) => ed.src === conn.srcId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: conn.srcId, tgt: nodeId, cond: '' },
        ]);
      }
      setConn(null);
    }
  }

  function handleBodyMouseUp(e, nodeId) {
    if (conn && conn.srcId !== nodeId) {
      if (!edges.some((ed) => ed.src === conn.srcId && ed.tgt === nodeId)) {
        setEdges((p) => [
          ...p,
          { id: eid(), src: conn.srcId, tgt: nodeId, cond: '' },
        ]);
      }
      setConn(null);
    }
  }

  // Library drag/drop
  function handleLibDragStart(e, type, idOrType) {
    e.dataTransfer.setData(
      'application/femo-item',
      JSON.stringify({ type, id: idOrType })
    );
    e.dataTransfer.effectAllowed = 'copy';
  }

  function handleCanvasDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleCanvasDrop(e) {
    e.preventDefault();
    let data;
    try {
      data = JSON.parse(e.dataTransfer.getData('application/femo-item'));
    } catch {
      return;
    }
    if (!data) return;

    const [cx, cy] = xy(e);
    const dropX = cx - 50;
    const dropY = cy - 20;

    if (data.type === 'action') {
      let action = lib.actions.find((a) => a.id === data.id);
      if (action && isFinite(dropX) && isFinite(dropY))
        addNode(action, dropX, dropY);
    } else if (data.type === 'module') {
      const mod = lib.modules.find((m) => m.id === data.id);
      if (mod) addModuleNode(mod, dropX, dropY);
    } else if (data.type === 'special') {
      addSpecialNode(data.id, dropX, dropY);
    } else if (data.type === 'position') {
      addPositionNode(dropX, dropY);
    }
  }

  // Compute temporary connection line
  function getTempConnLine() {
    if (!conn) return null;
    const srcNode = nm.get(conn.srcId);
    if (!srcNode) return null;
    const ss = getNodeSize(srcNode);

    let srcPort;
    switch (conn.srcDir) {
      case 'top':
        srcPort = { x: srcNode.x + ss.w / 2, y: srcNode.y };
        break;
      case 'bottom':
        srcPort = { x: srcNode.x + ss.w / 2, y: srcNode.y + ss.h };
        break;
      case 'left':
        srcPort = { x: srcNode.x, y: srcNode.y + ss.h / 2 };
        break;
      case 'right':
        srcPort = { x: srcNode.x + ss.w, y: srcNode.y + ss.h / 2 };
        break;
      default:
        srcPort = { x: srcNode.x + ss.w, y: srcNode.y + ss.h / 2 };
    }
    const dx = (conn.mx || 0) - srcPort.x;
    const dy = (conn.my || 0) - srcPort.y;
    let srcDir = conn.srcDir || 'right';
    if (!conn.srcDir) {
      if (Math.abs(dx) > Math.abs(dy)) srcDir = dx > 0 ? 'right' : 'left';
      else srcDir = dy > 0 ? 'bottom' : 'top';
    }
    const oppositeDir = {
      right: 'left',
      left: 'right',
      top: 'bottom',
      bottom: 'top',
    }[srcDir];
    return smartBezier(
      srcPort.x,
      srcPort.y,
      srcDir,
      conn.mx || srcPort.x,
      conn.my || srcPort.y,
      oppositeDir
    );
  }

  return {
    drag, setDrag,
    conn, setConn,
    isPanning, setIsPanning,
    panStart, setPanStart,
    onMM, onMU, onCanvasDown,
    handleWheel,
    handlePortDown, handlePortUp,
    handleBodyMouseUp,
    handleLibDragStart, handleCanvasDragOver, handleCanvasDrop,
    getTempConnLine,
    xy, nm,
  };
}

export { useCanvasInteraction };
