import type { KnowledgeNeighborhoodProjection } from '../../shared/knowledge'
import {
  forceCollide,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type SimulationNodeDatum
} from 'd3-force'

const MIN_SCENE_WIDTH = 220
const DEFAULT_SCENE_WIDTH = 720
const MIN_SCENE_HEIGHT = 190
const SCENE_PADDING_X = 16
const SCENE_PADDING_Y = 16
const NODE_GAP = 8
const EDGE_NODE_CLEARANCE = 3
const LINK_SURFACE_GAP = 46
const FORCE_TICK_LIMIT = 520
const FORCE_STABLE_TICKS = 14
const SECOND_HOP_REPULSION_BASE_RANGE = 140
const SECOND_HOP_REPULSION_RANGE_PER_DENSE_NODE = 20
const SECOND_HOP_REPULSION_MAX_EXTRA_RANGE = 90
const SECOND_HOP_REPULSION_BASE_STRENGTH = 18
const SECOND_HOP_REPULSION_LINK_LOAD_STRENGTH = 2.5
const SECOND_HOP_REPULSION_MAX_FORCE = 6
const SECOND_HOP_REPULSION_WALL_REDIRECT_DISTANCE = 28

const NODE_DIMENSIONS = {
  center: { width: 152, height: 44 },
  firstHop: { width: 136, height: 40 },
  secondHop: { width: 112, height: 34 }
} as const

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

interface ForceNode extends KnowledgeLocalGraphSceneNode, SimulationNodeDatum {
  x: number
  y: number
  vx: number
  vy: number
}

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

function nodeDimensions(distance: number): { width: number; height: number } {
  if (distance === 0) return NODE_DIMENSIONS.center
  if (distance === 1) return NODE_DIMENSIONS.firstHop
  return NODE_DIMENSIONS.secondHop
}

function rectanglesOverlap(left: KnowledgeLocalGraphSceneNode, right: KnowledgeLocalGraphSceneNode): boolean {
  return Math.abs(left.x - right.x) < (left.width + right.width) / 2 + NODE_GAP
    && Math.abs(left.y - right.y) < (left.height + right.height) / 2 + NODE_GAP
}

function nodesHaveOverlaps(nodes: KnowledgeLocalGraphSceneNode[]): boolean {
  return nodes.some((node, index) => (
    nodes.slice(index + 1).some((other) => rectanglesOverlap(node, other))
  ))
}

function horizontalBounds(node: KnowledgeLocalGraphSceneNode, width: number): [number, number] {
  const halfSceneWidth = width / 2
  return [
    -halfSceneWidth + SCENE_PADDING_X + node.width / 2,
    halfSceneWidth - SCENE_PADDING_X - node.width / 2
  ]
}

function clampHorizontalPosition(nodes: ForceNode[], width: number): void {
  for (const node of nodes) {
    if (node.distance === 0) {
      node.x = 0
      node.y = 0
      node.vx = 0
      node.vy = 0
      continue
    }
    const [minimumX, maximumX] = horizontalBounds(node, width)
    node.x = clamp(node.x, minimumX, maximumX)
  }
}

function seedNodes(
  projection: KnowledgeNeighborhoodProjection,
  nodesByTitle: Map<string, KnowledgeNeighborhoodProjection['nodes'][number]>,
  components: string[][],
  adjacency: Map<string, Set<string>>,
  clusterByTitle: Map<string, number | undefined>
): ForceNode[] {
  const totalWeight = components.reduce((total, component) => total + component.length, 0) || 1
  const positionByTitle = new Map<string, Point>([
    [projection.centerTitle, { x: 0, y: 0 }]
  ])
  let angleCursor = -Math.PI * 1.5

  for (const component of components) {
    const sector = Math.PI * 2 * component.length / totalWeight
    const anchorAngle = angleCursor + sector / 2
    const firstHopTitles = component.filter((title) => (
      (nodesByTitle.get(title)?.distance ?? 1) === 1
    ))
    const firstHopSpread = Math.min(
      Math.min(sector * 0.58, Math.PI * 0.82),
      Math.max(0, firstHopTitles.length - 1) * 0.6
    )
    firstHopTitles.forEach((title, index) => {
      const angle = firstHopTitles.length <= 1
        ? anchorAngle
        : anchorAngle + firstHopSpread * (index / (firstHopTitles.length - 1) - 0.5)
      positionByTitle.set(title, {
        x: Math.cos(angle) * 78,
        y: Math.sin(angle) * 78
      })
    })

    const outerGroups = new Map<string, string[]>()
    for (const title of component) {
      if (firstHopTitles.includes(title)) continue
      const parentTitles = [...(adjacency.get(title) ?? [])]
        .filter((neighborTitle) => (nodesByTitle.get(neighborTitle)?.distance ?? 0) === 1)
        .sort(compareTitles)
      const key = JSON.stringify(parentTitles)
      const group = outerGroups.get(key) ?? []
      group.push(title)
      outerGroups.set(key, group)
    }
    for (const [parentKey, titles] of outerGroups) {
      titles.sort(compareTitles)
      const parentTitles = JSON.parse(parentKey) as string[]
      const parentDirections = parentTitles.flatMap((title) => {
        const position = positionByTitle.get(title)
        return position ? [position] : []
      })
      const direction = parentDirections.reduce(
        (total, position) => {
          const angle = Math.atan2(position.y, position.x)
          return { x: total.x + Math.cos(angle), y: total.y + Math.sin(angle) }
        },
        { x: 0, y: 0 }
      )
      const outerAnchorAngle = parentDirections.length && Math.hypot(direction.x, direction.y) > 0.001
        ? Math.atan2(direction.y, direction.x)
        : anchorAngle
      const outerSpread = Math.min(
        Math.min(sector * 0.58, Math.PI * 0.82),
        Math.max(0, titles.length - 1) * 0.48
      )
      titles.forEach((title, index) => {
        const angle = titles.length <= 1
          ? outerAnchorAngle
          : outerAnchorAngle + outerSpread * (index / (titles.length - 1) - 0.5)
        positionByTitle.set(title, {
          x: Math.cos(angle) * 124,
          y: Math.sin(angle) * 124
        })
      })
    }
    angleCursor += sector
  }

  return projection.nodes.map((node) => {
    const position = positionByTitle.get(node.title) ?? { x: 0, y: 0 }
    const dimensions = nodeDimensions(node.distance)
    return {
      ...node,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      width: dimensions.width,
      height: dimensions.height,
      clusterIndex: clusterByTitle.get(node.title),
      neighborTitles: [...(adjacency.get(node.title) ?? [])].sort(compareTitles)
    }
  })
}

function rectangleRayExtent(node: ForceNode, unitX: number, unitY: number): number {
  const extentX = Math.abs(unitX) < 0.001
    ? Number.POSITIVE_INFINITY
    : node.width / 2 / Math.abs(unitX)
  const extentY = Math.abs(unitY) < 0.001
    ? Number.POSITIVE_INFINITY
    : node.height / 2 / Math.abs(unitY)
  return Math.min(extentX, extentY)
}

function createLinkForce(edges: VisualEdge[]): Force<ForceNode, undefined> {
  let links: Array<[ForceNode, ForceNode]> = []
  const force = ((alpha: number): void => {
    for (let index = 0; index < links.length; index += 1) {
      const [source, target] = links[index]
      let deltaX = target.x + target.vx - source.x - source.vx
      let deltaY = target.y + target.vy - source.y - source.vy
      if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
        deltaX = index % 2 === 0 ? 0.01 : -0.01
        deltaY = index % 3 === 0 ? 0.01 : -0.01
      }
      const distance = Math.max(0.001, Math.hypot(deltaX, deltaY))
      const unitX = deltaX / distance
      const unitY = deltaY / distance
      const desiredDistance = rectangleRayExtent(source, unitX, unitY)
        + rectangleRayExtent(target, unitX, unitY)
        + LINK_SURFACE_GAP
      const movement = (distance - desiredDistance) * 0.14 * alpha
      const sourceMovable = source.distance === 0 ? 0 : 1
      const targetMovable = target.distance === 0 ? 0 : 1
      const totalMovement = sourceMovable + targetMovable || 1
      if (sourceMovable) {
        source.vx += unitX * movement * sourceMovable / totalMovement
        source.vy += unitY * movement * sourceMovable / totalMovement
      }
      if (targetMovable) {
        target.vx -= unitX * movement * targetMovable / totalMovement
        target.vy -= unitY * movement * targetMovable / totalMovement
      }
    }
  }) as Force<ForceNode, undefined>
  force.initialize = (nodes): void => {
    const nodesByTitle = new Map(nodes.map((node) => [node.title, node]))
    links = edges.flatMap((edge) => {
      const source = nodesByTitle.get(edge.sourceTitle)
      const target = nodesByTitle.get(edge.targetTitle)
      return source && target ? [[source, target]] : []
    })
  }
  return force
}

/**
 * Keeps graph-distance-two nodes in the visual periphery without assigning them a ring or
 * position. The force is emitted only by the fixed center, has a finite range, and fades
 * continuously to zero so reference springs remain free to form cohesive local clusters.
 */
function createSecondHopCenterRepulsionForce(
  edges: VisualEdge[],
  width: number
): Force<ForceNode, undefined> {
  let center: ForceNode | undefined
  let secondHopNodes: ForceNode[] = []
  let influenceRange = SECOND_HOP_REPULSION_BASE_RANGE
  const linkLoadByTitle = new Map<string, number>()
  for (const edge of edges) {
    linkLoadByTitle.set(edge.sourceTitle, (linkLoadByTitle.get(edge.sourceTitle) ?? 0) + 1)
    linkLoadByTitle.set(edge.targetTitle, (linkLoadByTitle.get(edge.targetTitle) ?? 0) + 1)
  }

  const force = ((alpha: number): void => {
    if (!center) return
    for (const node of secondHopNodes) {
      let deltaX = node.x + node.vx - center.x
      let deltaY = node.y + node.vy - center.y
      if (Math.abs(deltaX) + Math.abs(deltaY) < 0.001) {
        deltaX = node.index && node.index % 2 === 0 ? 0.01 : -0.01
        deltaY = node.index && node.index % 3 === 0 ? 0.01 : -0.01
      }
      const distance = Math.max(0.001, Math.hypot(deltaX, deltaY))
      if (distance >= influenceRange) continue
      const proximity = 1 - distance / influenceRange
      const linkLoad = Math.sqrt(linkLoadByTitle.get(node.title) ?? 1)
      const magnitude = Math.min(
        SECOND_HOP_REPULSION_MAX_FORCE,
        (SECOND_HOP_REPULSION_BASE_STRENGTH
          + linkLoad * SECOND_HOP_REPULSION_LINK_LOAD_STRENGTH)
          * proximity * proximity
      ) * alpha
      let directionX = deltaX / distance
      let directionY = deltaY / distance
      const [minimumX, maximumX] = horizontalBounds(node, width)
      const outwardWallDistance = directionX < 0
        ? node.x - minimumX
        : maximumX - node.x
      const wallRedirect = clamp(
        1 - outwardWallDistance / SECOND_HOP_REPULSION_WALL_REDIRECT_DISTANCE,
        0,
        1
      ) * Math.abs(directionX)
      if (wallRedirect > 0) {
        directionX *= 1 - wallRedirect
        const verticalDirection = Math.abs(directionY) >= 0.05
          ? Math.sign(directionY)
          : node.index && node.index % 2 === 0 ? 1 : -1
        directionY += verticalDirection * wallRedirect
        const redirectedLength = Math.max(0.001, Math.hypot(directionX, directionY))
        directionX /= redirectedLength
        directionY /= redirectedLength
      }
      node.vx += directionX * magnitude
      node.vy += directionY * magnitude
    }
  }) as Force<ForceNode, undefined>

  force.initialize = (nodes): void => {
    center = nodes.find((node) => node.distance === 0)
    secondHopNodes = nodes.filter((node) => node.distance >= 2)
    const denseNodeCount = Math.max(0, nodes.length - 4)
    influenceRange = SECOND_HOP_REPULSION_BASE_RANGE + Math.min(
      SECOND_HOP_REPULSION_MAX_EXTRA_RANGE,
      Math.sqrt(denseNodeCount) * SECOND_HOP_REPULSION_RANGE_PER_DENSE_NODE
    )
  }

  return force
}

function createRectangleCollisionForce(width: number, iterations = 6): Force<ForceNode, undefined> {
  let nodes: ForceNode[] = []
  const force = (() => {
    for (let pass = 0; pass < iterations; pass += 1) {
      for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
          const left = nodes[leftIndex]
          const right = nodes[rightIndex]
          const deltaX = right.x + right.vx - left.x - left.vx
          const deltaY = right.y + right.vy - left.y - left.vy
          const requiredX = (left.width + right.width) / 2 + NODE_GAP
          const requiredY = (left.height + right.height) / 2 + NODE_GAP
          const overlapX = requiredX - Math.abs(deltaX)
          const overlapY = requiredY - Math.abs(deltaY)
          if (overlapX <= 0 || overlapY <= 0) continue

          const leftMovable = left.distance === 0 ? 0 : 1
          const rightMovable = right.distance === 0 ? 0 : 1
          const totalMovement = leftMovable + rightMovable || 1
          const horizontalDirection = deltaX === 0 ? (rightIndex % 2 === 0 ? 1 : -1) : Math.sign(deltaX)
          const horizontalCapacity = (leftMovable
            ? horizontalDirection > 0
              ? left.x - horizontalBounds(left, width)[0]
              : horizontalBounds(left, width)[1] - left.x
            : 0)
            + (rightMovable
              ? horizontalDirection > 0
                ? horizontalBounds(right, width)[1] - right.x
                : right.x - horizontalBounds(right, width)[0]
              : 0)
          const canResolveHorizontally = horizontalCapacity >= overlapX + 0.05
          if (overlapX / requiredX < overlapY / requiredY && canResolveHorizontally) {
            const direction = horizontalDirection
            const movement = overlapX + 0.05
            left.vx -= direction * movement * leftMovable / totalMovement
            right.vx += direction * movement * rightMovable / totalMovement
          } else {
            const direction = deltaY === 0 ? (rightIndex % 2 === 0 ? 1 : -1) : Math.sign(deltaY)
            const movement = overlapY + 0.05
            left.vy -= direction * movement * leftMovable / totalMovement
            right.vy += direction * movement * rightMovable / totalMovement
          }
        }
      }
    }
  }) as Force<ForceNode, undefined>
  force.initialize = (newNodes): void => {
    nodes = newNodes
  }
  return force
}

function settleNodes(nodes: ForceNode[], edges: VisualEdge[], width: number): void {
  const center = nodes.find((node) => node.distance === 0)
  if (center) {
    center.fx = 0
    center.fy = 0
  }
  const linkForce = createLinkForce(edges)
  const chargeForce = forceManyBody<ForceNode>().strength(-6).distanceMin(24).distanceMax(160)
  const secondHopRepulsionForce = createSecondHopCenterRepulsionForce(edges, width)
  const xForce = forceX<ForceNode>(0).strength((node) => node.distance === 0 ? 1 : node.distance === 1 ? 0.008 : 0)
  const yForce = forceY<ForceNode>(0).strength((node) => node.distance === 0 ? 1 : node.distance === 1 ? 0.008 : 0)
  const simulation = forceSimulation(nodes)
    .stop()
    .alpha(1)
    .alphaMin(0.001)
    .alphaDecay(1 - Math.pow(0.001, 1 / 240))
    .velocityDecay(0.42)
    .force('links', linkForce)
    .force('charge', chargeForce)
    .force('second-hop-center-repulsion', secondHopRepulsionForce)
    .force('x', xForce)
    .force('y', yForce)
    .force('collision', createRectangleCollisionForce(width))

  let stableTicks = 0
  for (let tick = 0; tick < FORCE_TICK_LIMIT; tick += 1) {
    const previousPositions = nodes.map((node) => ({ x: node.x, y: node.y }))
    simulation.tick()
    clampHorizontalPosition(nodes, width)
    const maximumMovement = nodes.reduce((maximum, node, index) => Math.max(
      maximum,
      Math.hypot(node.x - previousPositions[index].x, node.y - previousPositions[index].y)
    ), 0)
    stableTicks = tick > 60 && maximumMovement < 0.08 ? stableTicks + 1 : 0
    if (stableTicks >= FORCE_STABLE_TICKS) break
  }
  if (nodesHaveOverlaps(nodes)) {
    simulation
      .force('links', null)
      .force('charge', null)
      .force('second-hop-center-repulsion', null)
      .force('x', null)
      .force('y', null)
      .force('collision', forceCollide<ForceNode>()
        .radius((node) => Math.hypot(node.width, node.height) / 2 + NODE_GAP / 2)
        .strength(1)
        .iterations(4))
    for (const node of nodes) {
      node.vx = 0
      node.vy = 0
    }
  }
  for (let pass = 0; pass < 4 && nodesHaveOverlaps(nodes); pass += 1) {
    simulation.alpha(0.3)
    let clearTicks = 0
    for (let tick = 0; tick < 220; tick += 1) {
      simulation.tick()
      clampHorizontalPosition(nodes, width)
      clearTicks = nodesHaveOverlaps(nodes) ? 0 : clearTicks + 1
      if (clearTicks >= FORCE_STABLE_TICKS) break
    }
  }
  simulation.stop()
}

function compactNodes(nodes: ForceNode[], width: number): {
  nodes: KnowledgeLocalGraphSceneNode[]
  height: number
} {
  const minimumY = Math.min(...nodes.map((node) => node.y - node.height / 2))
  const maximumY = Math.max(...nodes.map((node) => node.y + node.height / 2))
  const contentHeight = maximumY - minimumY
  const height = Math.max(MIN_SCENE_HEIGHT, Math.ceil(contentHeight + SCENE_PADDING_Y * 2))
  const offsetY = (height - contentHeight) / 2 - minimumY
  return {
    height,
    nodes: nodes.map((node) => ({
      title: node.title,
      excerpt: node.excerpt,
      distance: node.distance,
      x: rounded(node.x + width / 2),
      y: rounded(node.y + offsetY),
      width: node.width,
      height: node.height,
      clusterIndex: node.clusterIndex,
      neighborTitles: node.neighborTitles
    }))
  }
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
        -direction * baseOffset * 2.25,
        direction * baseOffset * 3.5,
        -direction * baseOffset * 3.5,
        direction * baseOffset * 5,
        -direction * baseOffset * 5,
        direction * baseOffset * 7,
        -direction * baseOffset * 7
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

  const visualEdges = [...undirectedEdges.values()].map((edge) => {
    const sourceCluster = clusterByTitle.get(edge.sourceTitle)
    const targetCluster = clusterByTitle.get(edge.targetTitle)
    const clusterIndex = sourceCluster !== undefined && sourceCluster === targetCluster
      ? sourceCluster
      : undefined
    return { ...edge, clusterIndex }
  })
  const forceNodes = seedNodes(
    projection,
    nodesByTitle,
    components,
    adjacency,
    clusterByTitle
  )
  settleNodes(forceNodes, visualEdges, width)
  const compacted = compactNodes(forceNodes, width)

  return {
    width,
    height: compacted.height,
    nodes: compacted.nodes,
    edges: routeEdges(visualEdges, compacted.nodes, width, compacted.height),
    clusterCount: nextClusterIndex
  }
}
