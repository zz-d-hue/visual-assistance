export function drawOverlay(canvas: HTMLCanvasElement | null, dets: Det[], keepBackground = false) {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  if (!keepBackground) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  ctx.lineWidth = 0;
  ctx.font = '16px system-ui';
  const padding = 8;
  const arrowSize = 6;
  const gap = 6;

  for (const det of dets) {
    const [x, y, w, h] = det.bbox;
    const label = det.label || det.class || '物体';

    const textMetrics = ctx.measureText(label);
    const tw = textMetrics.width;
    const th = 18;
    const boxW = tw + padding * 2;
    const boxH = th + padding * 2;

    const rawCx = x + w / 2;
    const offsetX = canvas.width * 0.15;
    const cx = rawCx + offsetX;
    const topY = y;

    const anchorX = cx;
    const anchorY = topY;

    let tx = cx - boxW / 2;
    let ty = topY - boxH - gap;

    let arrowDir: 'up' | 'down' = 'down';
    if (ty < 0) {
      ty = topY + gap;
      arrowDir = 'up';
    }
    tx = Math.max(0, Math.min(canvas.width - boxW, tx));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    (ctx as any).roundRect(tx, ty, boxW, boxH, 6);
    ctx.fill();

    ctx.beginPath();
    const arrowX = Math.max(tx + 6, Math.min(tx + boxW - 6, anchorX));
    if (arrowDir === 'down') {
      ctx.moveTo(arrowX - arrowSize, ty + boxH);
      ctx.lineTo(arrowX + arrowSize, ty + boxH);
      ctx.lineTo(arrowX, ty + boxH + arrowSize);
    } else {
      ctx.moveTo(arrowX - arrowSize, ty);
      ctx.lineTo(arrowX + arrowSize, ty);
      ctx.lineTo(arrowX, ty - arrowSize);
    }
    ctx.fill();

    ctx.beginPath();
    ctx.arc(anchorX, anchorY, 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, tx + padding, ty + padding + th - 4);
  }

  if (dets.length > 0) {
    const text = `识别：${dets.length}`;
    ctx.font = '14px system-ui';
    const tw = ctx.measureText(text).width + 16;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    (ctx as any).roundRect(8, 8, tw, 28, 14);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 16, 27);
  }
}
