import type { KnowledgeNeighborhoodProjection } from '../../shared/knowledge'

export const KNOWLEDGE_LOCAL_GRAPH_NODE_WIDTH = 136
export const KNOWLEDGE_LOCAL_GRAPH_NODE_HEIGHT = 44

const MIN_SCENE_WIDTH = 220
const DEFAULT_SCENE_WIDTH = 720
const MIN_SCENE_HEIGHT = 320
const SCENE_PADDING_X = 22
const SCENE_PADDING_Y = 24
const NODE_GAP_X = 30
const NODE_GAP_Y = 24
const EDGE_NODE_CLEARANCE = 3

export interface KnowledgeLocalGraphSceneNode {
  title: string
  excerpt: string
  distance: number
  x: number
  y: number
  width: number
  height: number
  /** Renderer-local visual cluster. It has no Knowledge semantics or persistence. */
  clusterIndex?: number
  neighborTitles: string[]
}

export interface KnowledgeLocalGraphSceneEdge {
  sourceTitle: string
  targetTitle: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  controlX?: number
  controlY?: number
  path: string
  curved: boolean
  clusterIndex?: number
}

export interface KnowledgeLocalGraphScene {
  width: number
  height: number
  nodes: KnowledgeLocalGraphSceneNode[]
  edges: KnowledgeLocalGraphSceneEdge[]
  clusterCount: number
}

export interface KnowledgeLocalGraphLayoutOptions {
  width?: number
}

type PositionedNode = KnowledgeLocalGraphSceneNode

interface Point {
  x: number
  y: number
}

interface Rectangle {
  left: number
  right: number
  top: number
  bottom: number
}

interface VisualEdge {
  sourceTitle: string
  targetTitle: string
  clusterIndex?: number
}

interface RoutedCandidate {
  source: Point
  target: Point
  control?: Point
  points: Point[]
  offset: number
  score: number
}

function compareTitles(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right)
}

function undirectedKey(left: string, right: string): string {
  return JSON.stringify([left, right].sort(compareTitles))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100
}

function nodeRectangle(node: KnowledgeLocalGraphSceneNode, clearance = 0): Rectangle {
  return {
    left: node.x - node.width / 2 - clearance,
    right: node.x + node.width / 2 + clearance,
    top: node.y - node.height / 2 - clearance,
    bottom: node.y + node.height / 2 + clearance
  }
}

function rectanglesOverlap(left: KnowledgeLocalGraphSceneNode, right: KnowledgeLocalGraphSceneNode): boolean {
  return Math.abs(left.x - right.x) < (left.width + right.width) / 2 + NODE_GAP_X
    && Math.abs(left.y - right.y) < (left.height + right.height) / 2 + NODE_GAP_Y
}

function hasNodeOverlap(nodes: KnowledgeLocalGraphSceneNode[]): boolean {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      if (rectanglesOverlap(nodes[leftIndex], nodes[rightIndex])) return true
    }
  }
  return false
}

function resolveNodeOverlaps(nodes: PositionedNode[], width: number, height: number): boolean {
  const minimumX = SCENE_PADDING_X + KNOWLEDGE_LOCAL_GRAPH_NODE_WIDTH / 2
  const maximumX = width - minimumX
  const minimumY = SCENE_PADDING_Y + KNOWLEDGE_LOCAL_GRAPH_NODE_HEIGHT / 2
  const maximumY = height - minimumY

  for (let iteration = 0; iteration < 480; iteration += 1) {
    let overlapCount = 0
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex]
        const right = nodes[rightIndex]
        const deltaX = right.x - left.x
        const deltaY = right.y - left.y
        const requiredX = (left.width + right.width) / 2 + NODE_GAP_X
        const requiredY = (left.height + right.height) / 2 + NODE_GAP_Y
        const overlapX = requiredX - Math.abs(deltaX)
        const overlapY = requiredY - Math.abs(deltaY)
        if (overlapX <= 0 || overlapY <= 0) continue
        overlapCount += 1

        const leftPinned = left.distance === 0
        const rightPinned = right.distance === 0
        const moveLeft = leftPinned ? 0 : rightPinned ? 1 : 0.5
        const moveRight = rightPinned ? 0 : leftPinned ? 1 : 0.5
        if (overlapX / requiredX < overlapY / requiredY) {
          const direction = deltaX === 0 ? (leftIndex % 2 === 0 ? 1 : -1) : Math.sign(deltaX)
          const movement = overlapX + 0.5
          left.x -= direction * movement * moveLeft
          right.x += direction * movement * moveRight
        } else {
          const direction = deltaY === 0 ? (leftIndex % 2 === 0 ? 1 : -1) : Math.sign(deltaY)
          const movement = overlapY + 0.5
          left.y -= direction * movement * moveLeft
          right.y += direction * movement * moveRight
        }
      }
    }

    for (const node of nodes) {
      if (node.distance === 0) continue
      node.x = clamp(node.x, minimumX, maximumX)
      node.y = clamp(node.y, minimumY, maximumY)
    }
    if (overlapCount === 0) return true
  }
  return !hasNodeOverlap(nodes)
}

function initialSceneHeight(nodeCount: number, width: number): number {
  const availableWidth = Math.max(
    KNOWLEDGE_LOCAL_GRAPH_NODE_WIDTH,
    width - SCENE_PADDING_X * 2
  )
  const columns = Math.max(1, Math.floor(
    availableWidth / (KNOWLEDGE_LOCAL_GRAPH_NODE_WIDTH + NODE_GAP_X)
  ))
  const rows = Math.ceil(Math.max(1, nodeCount) / columns)
  return Math.max(
    MIN_SCENE_HEIGHT,
    190 + rows * (KNOWLEDGE_LOCAL_GRAPH_NODE_HEIGHT + NODE_GAP_Y)
  )
}

function seedNodes(
  projection: KnowledgeNeighborhoodProjection,
  nodesByTitle: Map<string, KnowledgeNeighborhoodProjection['nodes'][number]>,
  components: string[][],
  adjacency: Map<string, Set<string>>,
  clusterByTitle: Map<string, number | undefined>,
  width: number,
  height: number
): PositionedNode[] {
  const centerX = width / 2
  const centerY = height / 2
  const outerRadiusX = Math.max(
    72,
    centerX - SCENE_PADDING_X - KNOWLEDGE_LOCAL_GRAPH_NODE_WIDTH / 2
  )
  const outerRadiusY = Math.max(
    82,
    centerY - SCENE_PADDING_Y - KNOWLEDGE_LOCAL_GRAPH_NODE_HEIGHT / 2
  )
  const totalWeight = components.reduce((total, component) => total + component.length, 0) || 1
  const positionByTitle = new Map<string, Point>([
    [projection.centerTitle, { x: centerX, y: centerY }]
  ])
  let angleCursor = -Math.PI / 2

  for (const component of components) {
    const sector = Math.PI * 2 * component.length / totalWeight
    const sectorPadding = Math.min(0.16, sector * 0.08)
    const usableSector = Math.max(0, sector - sectorPadding * 2)
    component.forEach((title, index) => {
      const node = nodesByTitle.get(title)
      const angle = component.length === 1
        ? angleCursor + sector / 2
        : angleCursor + sectorPadding + usableSector * (index + 0.5) / component.length
      const ringFactor = node?.distance === 1 ? 0.56 : 0.94
      positionByTitle.set(title, {
        x: centerX + Math.cos(angle) * outerRadiusX * ringFactor,
        y: centerY + Math.sin(angle) * outerRadiusY * ringFactor
      })
    })
    angleCursor += sector
  }

  return projection.nodes.map((node) => {
    const position = positionByTitle.get(node.title) ?? { x: centerX, y: centerY }
    return {
      ...node,
      x: position.x,
      y: position.y,
      width: KNOWLEDGE_LOCAL_GRAPH_NODE_WIDTH,
      height: KNOWLEDGE_LOCAL_GRAPH_NODE_HEIGHT,
      clusterIndex: clusterByTitle.get(node.title),
      neighborTitles: [...(adjacency.get(node.title) ?? [])].sort(compareTitles)
    }
  })
}

function pointInsideRectangle(point: Point, rectangle: Rectangle): boolean {
  return point.x > rectangle.left
    && point.x < rectangle.right
    && point.y > rectangle.top
    && point.y < rectangle.bottom
}

function orientation(first: Point, second: Point, third: Point): number {
  return (second.x - first.x) * (third.y - first.y)
    - (second.y - first.y) * (third.x - first.x)
}

function segmentsCross(firstStart: Point, firstEnd: Point, secondStart: Point, secondEnd: Point): boolean {
  const firstA = orientation(firstStart, firstEnd, secondStart)
  const firstB = orientation(firstStart, firstEnd, secondEnd)
  const secondA = orientation(secondStart, secondEnd, firstStart)
  const secondB = orientation(secondStart, secondEnd, firstEnd)
  return firstA * firstB < -0.001 && secondA * secondB < -0.001
}

function segmentIntersectsRectangle(start: Point, end: Point, rectangle: Rectangle): boolean {
  if (pointInsideRectangle(start, rectangle) || pointInsideRectangle(end, rectangle)) return true
  const topLeft = { x: rectangle.left, y: rectangle.top }
  const topRight = { x: rectangle.right, y: rectangle.top }
  const bottomRight = { x: rectangle.right, y: rectangle.bottom }
  const bottomLeft = { x: rectangle.left, y: rectangle.bottom }
  return segmentsCross(start, end, topLeft, topRight)
    || segmentsCross(start, end, topRight, bottomRight)
    || segmentsCross(start, end, bottomRight, bottomLeft)
    || segmentsCross(start, end, bottomLeft, topLeft)
}

function pathIntersectsRectangle(points: Point[], rectangle: Rectangle): boolean {
  for (let index = 1; index < points.length; index += 1) {
    if (segmentIntersectsRectangle(points[index - 1], points[index], rectangle)) return true
  }
  return false
}

function pathCrossingCount(first: Point[], second: Point[]): number {
  let crossings = 0
  for (let firstIndex = 1; firstIndex < first.length; firstIndex += 1) {
    for (let secondIndex = 1; secondIndex < second.length; secondIndex += 1) {
      if (segmentsCross(
        first[firstIndex - 1],
        first[firstIndex],
        second[secondIndex - 1],
        second[secondIndex]
      )) crossings += 1
    }
  }
  return crossings
}

function clipToNodeBoundary(node: KnowledgeLocalGraphSceneNode, toward: Point): Point {
  const deltaX = toward.x - node.x
  const deltaY = toward.y - node.y
  if (Math.abs(deltaX) < 0.001 && Math.abs(deltaY) < 0.001) return { x: node.x, y: node.y }
  const halfWidth = node.width / 2 + EDGE_NODE_CLEARANCE
  const halfHeight = node.height / 2 + EDGE_NODE_CLEARANCE
  const scaleX = Math.abs(deltaX) < 0.001 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(deltaX)
  const scaleY = Math.abs(deltaY) < 0.001 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(deltaY)
  const scale = Math.min(scaleX, scaleY)
  return {
    x: node.x + deltaX * scale,
    y: node.y + deltaY * scale
  }
}

function sampledPath(source: Point, target: Point, control?: Point): Point[] {
  if (!control) return [source, target]
  const points: Point[] = []
  for (let index = 0; index <= 32; index += 1) {
    const progress = index / 32
    const inverse = 1 - progress
    points.push({
      x: inverse * inverse * source.x + 2 * inverse * progress * control.x + progress * progress * target.x,
      y: inverse * inverse * source.y + 2 * inverse * progress * control.y + progress * progress * target.y
    })
  }
  return points
}

function routeCandidate(
  sourceNode: KnowledgeLocalGraphSceneNode,
  targetNode: KnowledgeLocalGraphSceneNode,
  offset: number,
  nodes: KnowledgeLocalGraphSceneNode[],
  otherBaselinePaths: Array<{ edge: VisualEdge; points: Point[] }>,
  edge: VisualEdge,
  width: number,
  height: number
): RoutedCandidate {
  const deltaX = targetNode.x - sourceNode.x
  const deltaY = targetNode.y - sourceNode.y
  const length = Math.max(1, Math.hypot(deltaX, deltaY))
  const midpoint = {
    x: (sourceNode.x + targetNode.x) / 2,
    y: (sourceNode.y + targetNode.y) / 2
  }
  const control = Math.abs(offset) < 0.01
    ? undefined
    : {
        x: midpoint.x - deltaY / length * offset,
        y: midpoint.y + deltaX / length * offset
      }
  const source = clipToNodeBoundary(sourceNode, control ?? targetNode)
  const target = clipToNodeBoundary(targetNode, control ?? sourceNode)
  const points = sampledPath(source, target, control)
  const obstacleHits = nodes.filter((node) => (
    node.title !== edge.sourceTitle
    && node.title !== edge.targetTitle
    && pathIntersectsRectangle(points, nodeRectangle(node, EDGE_NODE_CLEARANCE))
  )).length
  const crossings = otherBaselinePaths.reduce((total, other) => {
    const sharesEndpoint = edge.sourceTitle === other.edge.sourceTitle
      || edge.sourceTitle === other.edge.targetTitle
      || edge.targetTitle === other.edge.sourceTitle
      || edge.targetTitle === other.edge.targetTitle
    return total + (sharesEndpoint ? 0 : pathCrossingCount(points, other.points))
  }, 0)
  const outsidePoints = points.filter((point) => (
    point.x < SCENE_PADDING_X / 2
    || point.x > width - SCENE_PADDING_X / 2
    || point.y < SCENE_PADDING_Y / 2
    || point.y > height - SCENE_PADDING_Y / 2
  )).length
  return {
    source,
    target,
    control,
    points,
    offset,
    score: obstacleHits * 100_000 + crossings * 1_000 + outsidePoints * 10_000 + Math.abs(offset)
  }
}

function routeEdges(
  visualEdges: VisualEdge[],
  nodes: KnowledgeLocalGraphSceneNode[],
  width: number,
  height: number
): KnowledgeLocalGraphSceneEdge[] {
  const nodesByTitle = new Map(nodes.map((node) => [node.title, node]))
  const baselinePaths = visualEdges.map((edge) => {
    const source = nodesByTitle.get(edge.sourceTitle)
    const target = nodesByTitle.get(edge.targetTitle)
    if (!source || !target) throw new Error('Local graph scene 缺少引用端点')
    const sourcePoint = clipToNodeBoundary(source, target)
    const targetPoint = clipToNodeBoundary(target, source)
    return { edge, points: [sourcePoint, targetPoint] }
  })

  return visualEdges.map((edge, edgeIndex) => {
    const source = nodesByTitle.get(edge.sourceTitle)
    const target = nodesByTitle.get(edge.targetTitle)
    if (!source || !target) throw new Error('Local graph scene 缺少引用端点')
    const otherBaselinePaths = baselinePaths.filter((item) => item.edge !== edge)
    const straight = routeCandidate(source, target, 0, nodes, otherBaselinePaths, edge, width, height)
    const straightHasConflict = straight.score >= 1_000
    let selected = straight
    if (straightHasConflict) {
      const length = Math.hypot(target.x - source.x, target.y - source.y)
      const baseOffset = clamp(length * 0.1, 14, 26)
      const direction = edgeIndex % 2 === 0 ? 1 : -1
      const offsets = [
        direction * baseOffset,
        -direction * baseOffset,
        direction * baseOffset * 1.5,
        -direction * baseOffset * 1.5,
        direction * baseOffset * 2.25,
        -direction * baseOffset * 2.25
      ]
      for (const offset of offsets) {
        const candidate = routeCandidate(
          source,
          target,
          offset,
          nodes,
          otherBaselinePaths,
          edge,
          width,
          height
        )
        if (candidate.score < selected.score) selected = candidate
      }
    }
    const curved = Boolean(selected.control)
    const path = curved
      ? `M ${rounded(selected.source.x)} ${rounded(selected.source.y)} Q ${rounded(selected.control!.x)} ${rounded(selected.control!.y)} ${rounded(selected.target.x)} ${rounded(selected.target.y)}`
      : `M ${rounded(selected.source.x)} ${rounded(selected.source.y)} L ${rounded(selected.target.x)} ${rounded(selected.target.y)}`
    return {
      ...edge,
      sourceX: selected.source.x,
      sourceY: selected.source.y,
      targetX: selected.target.x,
      targetY: selected.target.y,
      controlX: selected.control?.x,
      controlY: selected.control?.y,
      path,
      curved
    }
  })
}

/**
 * Builds a deterministic, renderer-only scene from reference facts. Topology seeds the radial
 * arrangement; label rectangles then resolve collisions before edges are routed around labels.
 */
export function buildKnowledgeLocalGraphScene(
  projection: KnowledgeNeighborhoodProjection,
  options: KnowledgeLocalGraphLayoutOptions = {}
): KnowledgeLocalGraphScene {
  const width = Math.max(MIN_SCENE_WIDTH, Math.round(options.width ?? DEFAULT_SCENE_WIDTH))
  const nodesByTitle = new Map(projection.nodes.map((node) => [node.title, node]))
  const adjacency = new Map<string, Set<string>>()
  const undirectedEdges = new Map<string, { sourceTitle: string; targetTitle: string }>()

  for (const edge of projection.edges) {
    if (
      edge.sourceTitle === edge.targetTitle
      || !nodesByTitle.has(edge.sourceTitle)
      || !nodesByTitle.has(edge.targetTitle)
    ) continue
    const key = undirectedKey(edge.sourceTitle, edge.targetTitle)
    if (!undirectedEdges.has(key)) {
      const [sourceTitle, targetTitle] = [edge.sourceTitle, edge.targetTitle].sort(compareTitles)
      undirectedEdges.set(key, { sourceTitle, targetTitle })
    }
    const sourceNeighbors = adjacency.get(edge.sourceTitle) ?? new Set<string>()
    sourceNeighbors.add(edge.targetTitle)
    adjacency.set(edge.sourceTitle, sourceNeighbors)
    const targetNeighbors = adjacency.get(edge.targetTitle) ?? new Set<string>()
    targetNeighbors.add(edge.sourceTitle)
    adjacency.set(edge.targetTitle, targetNeighbors)
  }

  const unvisited = new Set(
    projection.nodes
      .map((node) => node.title)
      .filter((title) => title !== projection.centerTitle)
  )
  const components: string[][] = []
  while (unvisited.size) {
    const start = [...unvisited].sort(compareTitles)[0]
    const component: string[] = []
    const queue = [start]
    unvisited.delete(start)
    for (let index = 0; index < queue.length; index += 1) {
      const title = queue[index]
      component.push(title)
      for (const neighborTitle of [...(adjacency.get(title) ?? [])].sort(compareTitles)) {
        if (neighborTitle === projection.centerTitle || !unvisited.has(neighborTitle)) continue
        unvisited.delete(neighborTitle)
        queue.push(neighborTitle)
      }
    }
    component.sort((left, right) => (
      (nodesByTitle.get(left)?.distance ?? 0) - (nodesByTitle.get(right)?.distance ?? 0)
      || compareTitles(left, right)
    ))
    components.push(component)
  }
  components.sort((left, right) => compareTitles(left[0], right[0]))

  let nextClusterIndex = 0
  const clusterByTitle = new Map<string, number | undefined>()
  for (const component of components) {
    const clusterIndex = component.length > 1 ? nextClusterIndex++ : undefined
    for (const title of component) clusterByTitle.set(title, clusterIndex)
  }

  const initialHeight = initialSceneHeight(projection.nodes.length, width)
  const maximumHeight = Math.max(
    initialHeight,
    SCENE_PADDING_Y * 2 + projection.nodes.length * (KNOWLEDGE_LOCAL_GRAPH_NODE_HEIGHT + NODE_GAP_Y)
  )
  let height = initialHeight
  let positionedNodes: PositionedNode[] = []
  while (true) {
    positionedNodes = seedNodes(
      projection,
      nodesByTitle,
      components,
      adjacency,
      clusterByTitle,
      width,
      height
    )
    if (resolveNodeOverlaps(positionedNodes, width, height)) break
    if (height >= maximumHeight) break
    height = Math.min(maximumHeight, height + Math.max(72, Math.ceil(height * 0.16)))
  }

  const nodes = positionedNodes
  const sceneNodesByTitle = new Map(nodes.map((node) => [node.title, node]))
  const visualEdges = [...undirectedEdges.values()].map((edge) => {
    const source = sceneNodesByTitle.get(edge.sourceTitle)
    const target = sceneNodesByTitle.get(edge.targetTitle)
    if (!source || !target) throw new Error('Local graph scene 缺少引用端点')
    const clusterIndex = source.clusterIndex !== undefined
      && source.clusterIndex === target.clusterIndex
      ? source.clusterIndex
      : undefined
    return { ...edge, clusterIndex }
  })

  return {
    width,
    height,
    nodes,
    edges: routeEdges(visualEdges, nodes, width, height),
    clusterCount: nextClusterIndex
  }
}
