import {useCallback, useEffect, useMemo, useState} from 'react';
import {useTheme} from '@emotion/react';
import styled from '@emotion/styled';
import {mat3, vec2} from 'gl-matrix';

import {ViewHierarchyWindow} from 'sentry/components/events/viewHierarchy';
import {
  calculateScale,
  getDeepestNodeAtPoint,
  getHierarchyDimensions,
  useResizeCanvasObserver,
} from 'sentry/components/events/viewHierarchy/utils';
import {Rect} from 'sentry/utils/profiling/gl/utils';

const MIN_BORDER_SIZE = 20;

export interface ViewNode {
  node: ViewHierarchyWindow;
  rect: Rect;
}

type WireframeProps = {
  hierarchy: ViewHierarchyWindow[];
  onNodeSelect: (node?: ViewHierarchyWindow) => void;
  selectedNode?: ViewHierarchyWindow;
};

function Wireframe({hierarchy, selectedNode, onNodeSelect}: WireframeProps) {
  const theme = useTheme();
  const [canvasRef, setCanvasRef] = useState<HTMLCanvasElement | null>(null);
  const [overlayRef, setOverlayRef] = useState<HTMLCanvasElement | null>(null);

  const canvases = useMemo(() => {
    return canvasRef && overlayRef ? [canvasRef, overlayRef] : [];
  }, [canvasRef, overlayRef]);

  const canvasSize = useResizeCanvasObserver(canvases);

  const hierarchyData = useMemo(() => getHierarchyDimensions(hierarchy), [hierarchy]);
  const nodeLookupMap = useMemo(() => {
    const map = new Map<ViewHierarchyWindow, ViewNode>();
    hierarchyData.nodes.forEach(node => {
      map.set(node.node, node);
    });
    return map;
  }, [hierarchyData.nodes]);

  const scale = useMemo(() => {
    return calculateScale(
      {width: canvasSize.width, height: canvasSize.height},
      {width: hierarchyData.maxWidth, height: hierarchyData.maxHeight},
      {
        x: MIN_BORDER_SIZE,
        y: MIN_BORDER_SIZE,
      }
    );
  }, [
    canvasSize.height,
    canvasSize.width,
    hierarchyData.maxHeight,
    hierarchyData.maxWidth,
  ]);

  const transformationMatrix = useMemo(() => {
    const xCenter = Math.abs(canvasSize.width - hierarchyData.maxWidth * scale) / 2;
    const yCenter = Math.abs(canvasSize.height - hierarchyData.maxHeight * scale) / 2;

    // prettier-ignore
    return mat3.fromValues(
      scale, 0, 0,
      0, scale, 0,
      xCenter, yCenter, 1
    );
  }, [
    canvasSize.height,
    canvasSize.width,
    hierarchyData.maxHeight,
    hierarchyData.maxWidth,
    scale,
  ]);

  const setupCanvasContext = useCallback(
    (context: CanvasRenderingContext2D, modelToView: mat3) => {
      context.resetTransform();
      context.clearRect(0, 0, canvasSize.width, canvasSize.height);

      context.setTransform(
        modelToView[0],
        modelToView[3],
        modelToView[1],
        modelToView[4],
        modelToView[6],
        modelToView[7]
      );
    },
    [canvasSize.height, canvasSize.width]
  );

  const drawOverlay = useCallback(
    (modelToView: mat3, selectedRect: Rect | null, hoverRect: Rect | null) => {
      const overlay = overlayRef?.getContext('2d');
      if (overlay) {
        setupCanvasContext(overlay, modelToView);
        overlay.fillStyle = theme.blue200;

        if (selectedRect) {
          overlay.fillRect(
            selectedRect.x,
            selectedRect.y,
            selectedRect.width,
            selectedRect.height
          );
        }

        if (hoverRect) {
          overlay.fillStyle = theme.blue100;
          overlay.fillRect(hoverRect.x, hoverRect.y, hoverRect.width, hoverRect.height);
        }
      }
    },
    [overlayRef, setupCanvasContext, theme.blue100, theme.blue200]
  );

  const drawViewHierarchy = useCallback(
    (modelToView: mat3) => {
      const canvas = canvasRef?.getContext('2d');
      if (canvas) {
        setupCanvasContext(canvas, modelToView);
        canvas.fillStyle = theme.gray100;
        canvas.strokeStyle = theme.gray300;

        for (let i = 0; i < hierarchyData.nodes.length; i++) {
          canvas.strokeRect(
            hierarchyData.nodes[i].rect.x,
            hierarchyData.nodes[i].rect.y,
            hierarchyData.nodes[i].rect.width,
            hierarchyData.nodes[i].rect.height
          );
          canvas.fillRect(
            hierarchyData.nodes[i].rect.x,
            hierarchyData.nodes[i].rect.y,
            hierarchyData.nodes[i].rect.width,
            hierarchyData.nodes[i].rect.height
          );
        }
      }
    },
    [canvasRef, setupCanvasContext, theme.gray100, theme.gray300, hierarchyData.nodes]
  );

  useEffect(() => {
    if (!canvasRef || !overlayRef) {
      return undefined;
    }

    let start: vec2 | null;
    let isDragging = false;
    const selectedRect: Rect | null =
      (selectedNode && nodeLookupMap.get(selectedNode)?.rect) ?? null;
    let hoveredRect: Rect | null = null;
    const currTransformationMatrix = mat3.clone(transformationMatrix);

    const handleMouseDown = (e: MouseEvent) => {
      start = vec2.fromValues(e.offsetX, e.offsetY);
      overlayRef.style.cursor = 'grabbing';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (start) {
        isDragging = true;
        hoveredRect = null;
        const currPosition = vec2.fromValues(e.offsetX, e.offsetY);

        // Delta needs to be scaled by the devicePixelRatio and how
        // much we've zoomed the image by to get an accurate translation
        const delta = vec2.sub(vec2.create(), currPosition, start);
        vec2.scale(delta, delta, window.devicePixelRatio / scale);

        // Translate from the original matrix as a starting point
        mat3.translate(currTransformationMatrix, transformationMatrix, delta);
        drawViewHierarchy(currTransformationMatrix);
        drawOverlay(currTransformationMatrix, selectedRect, hoveredRect);
      } else {
        hoveredRect =
          getDeepestNodeAtPoint(
            hierarchyData.nodes,
            vec2.fromValues(e.offsetX, e.offsetY),
            currTransformationMatrix,
            window.devicePixelRatio
          )?.rect ?? null;
        drawOverlay(transformationMatrix, selectedRect, hoveredRect);
      }
    };

    const handleMouseUp = () => {
      if (isDragging) {
        // The panning has ended, store its transformations into the original matrix
        mat3.copy(transformationMatrix, currTransformationMatrix);
      }
      start = null;
      overlayRef.style.cursor = 'grab';
    };

    const handleMouseClick = (e: MouseEvent) => {
      if (!isDragging) {
        const clickedNode = getDeepestNodeAtPoint(
          hierarchyData.nodes,
          vec2.fromValues(e.offsetX, e.offsetY),
          transformationMatrix,
          window.devicePixelRatio
        );

        if (!clickedNode) {
          return;
        }

        drawOverlay(transformationMatrix, clickedNode?.rect ?? null, null);
        onNodeSelect(clickedNode?.node);
      }
      isDragging = false;
    };

    const options: AddEventListenerOptions & EventListenerOptions = {passive: true};

    overlayRef.addEventListener('mousedown', handleMouseDown, options);
    overlayRef.addEventListener('mousemove', handleMouseMove, options);
    overlayRef.addEventListener('mouseup', handleMouseUp, options);
    overlayRef.addEventListener('click', handleMouseClick, options);

    drawViewHierarchy(transformationMatrix);
    drawOverlay(transformationMatrix, selectedRect, hoveredRect);

    return () => {
      overlayRef.removeEventListener('mousedown', handleMouseDown, options);
      overlayRef.removeEventListener('mousemove', handleMouseMove, options);
      overlayRef.removeEventListener('mouseup', handleMouseUp, options);
      overlayRef.removeEventListener('click', handleMouseClick, options);
    };
  }, [
    transformationMatrix,
    canvasRef,
    scale,
    overlayRef,
    hierarchyData.nodes,
    onNodeSelect,
    drawViewHierarchy,
    drawOverlay,
    selectedNode,
    nodeLookupMap,
  ]);

  return (
    <Stack>
      <InteractionOverlayCanvas
        data-test-id="view-hierarchy-wireframe-overlay"
        ref={r => setOverlayRef(r)}
      />
      <WireframeCanvas
        data-test-id="view-hierarchy-wireframe"
        ref={r => setCanvasRef(r)}
      />
    </Stack>
  );
}

export {Wireframe};

const Stack = styled('div')`
  position: relative;
  height: 100%;
  width: 100%;
`;

const InteractionOverlayCanvas = styled('canvas')`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`;

const WireframeCanvas = styled('canvas')`
  background-color: ${p => p.theme.surface100};
  cursor: grab;
  width: 100%;
  height: 100%;
`;
