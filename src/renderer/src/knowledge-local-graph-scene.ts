import type { KnowledgeNeighborhoodProjection } from '../../shared/knowledge'

export interface KnowledgeLocalGraphSceneNode {
  title: string
  excerpt: string
  distance: number
  x: number
  y: number
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
  clusterIndex?: number
}

export interface KnowledgeLocalGraphScene {
  height: number
  nodes: KnowledgeLocalGraphSceneNode[]
  edges: KnowledgeLocalGraphSceneEdge[]
  clusterCount: number
}

function compareTitles(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right)
}

function undirectedKey(left: string, right: string): string {
  return JSON.stringify([left, right].sort(compareTitles))
}

/**
 * Builds a deterministic scene from reference facts only. Removing the center before finding
 * connected components keeps a star from being presented as one cohesive visual group.
 */
export function buildKnowledgeLocalGraphScene(
  projection: KnowledgeNeighborhoodProjection
): KnowledgeLocalGraphScene {
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

  const positionByTitle = new Map<string, { x: number; y: number; clusterIndex?: number }>()
  positionByTitle.set(projection.centerTitle, { x: 50, y: 50 })
  const totalWeight = components.reduce((total, component) => total + component.length, 0) || 1
  let angleCursor = -Math.PI / 2
  let nextClusterIndex = 0

  for (const component of components) {
    const sector = Math.PI * 2 * component.length / totalWeight
    const padding = Math.min(0.16, sector * 0.08)
    const usableSector = Math.max(0, sector - padding * 2)
    const clusterIndex = component.length > 1 ? nextClusterIndex++ : undefined
    component.forEach((title, index) => {
      const node = nodesByTitle.get(title)
      const angle = component.length === 1
        ? angleCursor + sector / 2
        : angleCursor + padding + usableSector * (index + 0.5) / component.length
      const distance = node?.distance ?? 1
      const radialJitter = component.length > 2 ? (index % 2 === 0 ? -1.5 : 1.5) : 0
      const radiusX = (distance === 1 ? 21 : 34) + radialJitter
      const radiusY = (distance === 1 ? 22 : 34) + radialJitter
      positionByTitle.set(title, {
        x: Math.min(84, Math.max(16, 50 + Math.cos(angle) * radiusX)),
        y: Math.min(87, Math.max(13, 50 + Math.sin(angle) * radiusY)),
        clusterIndex
      })
    })
    angleCursor += sector
  }

  const nodes = projection.nodes.map((node) => {
    const position = positionByTitle.get(node.title) ?? { x: 50, y: 50 }
    return {
      ...node,
      ...position,
      neighborTitles: [...(adjacency.get(node.title) ?? [])].sort(compareTitles)
    }
  })
  const sceneNodesByTitle = new Map(nodes.map((node) => [node.title, node]))
  const edges = [...undirectedEdges.values()].map((edge) => {
    const source = sceneNodesByTitle.get(edge.sourceTitle)
    const target = sceneNodesByTitle.get(edge.targetTitle)
    if (!source || !target) throw new Error('Local graph scene 缺少引用端点')
    const clusterIndex = source.clusterIndex !== undefined
      && source.clusterIndex === target.clusterIndex
      ? source.clusterIndex
      : undefined
    return {
      ...edge,
      sourceX: source.x,
      sourceY: source.y,
      targetX: target.x,
      targetY: target.y,
      clusterIndex
    }
  })

  return {
    height: Math.min(520, Math.max(320, 284 + Math.ceil(Math.max(0, nodes.length - 1) / 4) * 36)),
    nodes,
    edges,
    clusterCount: nextClusterIndex
  }
}
