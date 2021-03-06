import { ParsedQuery } from '../ParsedQueryNode';
import { JsonObject, JsonValue, PathPart } from '../primitive';
import { nodeIdForParameterizedValue } from './SnapshotEditor';
import { isNil, walkOperation } from '../util';
import { CacheContext } from '../context';
import { GraphSnapshot } from '../GraphSnapshot';
import { NodeId, OperationInstance, RawOperation } from '../schema';
import { isObject } from '../util';

export interface QueryResult {
  /** The value of the root requested by a query. */
  result?: JsonObject;
  /** Whether the query's selection set was satisfied. */
  complete: boolean;
}

export interface QueryResultWithNodeIds extends QueryResult {
  /** The ids of nodes selected by the query (if requested). */
  nodeIds: Set<NodeId>;
}

/**
 * Get you some data.
 */
export function read(context: CacheContext, query: RawOperation, snapshot: GraphSnapshot): QueryResult;
export function read(context: CacheContext, query: RawOperation, snapshot: GraphSnapshot, includeNodeIds: true): QueryResultWithNodeIds;
export function read(context: CacheContext, query: RawOperation, snapshot: GraphSnapshot, includeNodeIds?: true) {
  const operation = context.parseOperation(query);
  let queryResult = snapshot.readCache.get(operation) as Partial<QueryResultWithNodeIds>;
  if (!queryResult) {
    const staticResult = snapshot.getNodeData(operation.rootId);

    let result = staticResult;
    if (!operation.isStatic) {
      result = _walkAndOverlayDynamicValues(operation, context, snapshot, staticResult);
    }

    let { complete, nodeIds } = _visitSelection(operation, context, result, includeNodeIds);

    queryResult = { result, complete, nodeIds };
    snapshot.readCache.set(operation, queryResult as QueryResult);

    if (context.verbose) {
      const { info } = operation;
      context.debug(`read(${info.operationType} ${info.operationName})`, { result, complete, nodeIds, snapshot });
    }
  }

  // We can potentially ask for results without node ids first, and then follow
  // up with an ask for them.  In that case, we need to fill in the cache a bit
  // more.
  if (includeNodeIds && !queryResult.nodeIds) {
    const { complete, nodeIds } = _visitSelection(operation, context, queryResult.result, includeNodeIds);
    queryResult.complete = complete;
    queryResult.nodeIds = nodeIds;
  }

  return queryResult;
}

class OverlayWalkNode {
  constructor(
    public readonly value: JsonObject,
    public readonly containerId: NodeId,
    public readonly parsedMap: ParsedQuery,
    public readonly path: PathPart[],
  ) {}
}

/**
 * Walks a parameterized field map, overlaying values at those paths on top of
 * existing results.
 *
 * Overlaid values are objects with prototypes pointing to the original results,
 * and new properties pointing to the parameterized values (or objects that
 * contain them).
 */
export function _walkAndOverlayDynamicValues(
  query: OperationInstance,
  context: CacheContext,
  snapshot: GraphSnapshot,
  result: JsonObject,
): JsonObject {
  // Corner case: We stop walking once we reach a parameterized field with no
  // snapshot, but we should also preemptively stop walking if there are no
  // dynamic values to be overlaid
  const rootSnapshot = snapshot.getNodeSnapshot(query.rootId);
  if (isNil(rootSnapshot)) return result;

  // TODO: A better approach here might be to walk the outbound references from
  // each node, rather than walking the result set.  We'd have to store the path
  // on parameterized value nodes to make that happen.

  const newResult = _wrapValue(result, context);
  // TODO: This logic sucks.  We'd do much better if we had knowledge of the
  // schema.  Can we layer that on in such a way that we can support uses w/ and
  // w/o a schema compilation step?
  const queue = [new OverlayWalkNode(newResult, query.rootId, query.parsedQuery, [])];

  while (queue.length) {
    const walkNode = queue.pop()!;
    const { value, parsedMap } = walkNode;
    let { containerId, path } = walkNode;
    const valueId = context.entityIdForValue(value);
    if (valueId) {
      containerId = valueId;
      path = [];
    }

    for (const key in parsedMap) {
      let node = parsedMap[key];
      let child, childId;
      let fieldName = key;

      // This is an alias if we have a schemaName declared.
      fieldName = node.schemaName ? node.schemaName : key;

      if (node.args) {
        childId = nodeIdForParameterizedValue(containerId, [...path, fieldName], node.args);
        const childSnapshot = snapshot.getNodeSnapshot(childId);
        if (!childSnapshot) continue;
        child = childSnapshot.data;
      } else {
        child = value[fieldName];
      }

      // Have we reached a leaf (either in the query, or in the cache)?
      if (node.children && child !== null) {
        if (Array.isArray(child)) {
          child = [...child];
          for (let i = child.length - 1; i >= 0; i--) {
            if (child[i] === null) continue;
            child[i] = _wrapValue(child[i], context);
            queue.push(new OverlayWalkNode(child[i] as JsonObject, containerId, node.children, [...path, fieldName, i]));
          }

        } else {
          child = _wrapValue(child, context);
          queue.push(new OverlayWalkNode(child as JsonObject, containerId, node.children, [...path, fieldName]));
        }
      }

      // Because key is already a field alias, result will be written correctly
      // using alias as key.
      value[key] = child;
    }
  }

  return newResult;
}

function _wrapValue(value: JsonValue | undefined, context: CacheContext): any {
  if (value === undefined) return {};
  if (Array.isArray(value)) return [...value];
  if (isObject(value)) {
    const newValue = { ...value };
    if (context.entityTransformer && context.entityIdForValue(value)) {
      context.entityTransformer(newValue);
    }
    return newValue;
  }
  return value;
}

/**
 * Determines whether `result` satisfies the properties requested by `selection`.
 */
export function _visitSelection(
  query: OperationInstance,
  context: CacheContext,
  result?: JsonObject,
  includeNodeIds?: true,
): { complete: boolean, nodeIds?: Set<NodeId> } {
  let complete = true;
  let nodeIds: Set<NodeId> | undefined;
  if (includeNodeIds) {
    nodeIds = new Set<NodeId>();
    if (result !== undefined) {
      nodeIds.add(query.rootId);
    }
  }

  // TODO: Memoize per query, and propagate through cache snapshots.
  walkOperation(query.info.document, result, (value, fields) => {
    if (value === undefined) {
      complete = false;
    }

    // If we're not including node ids, we can stop the walk right here.
    if (!complete) return !includeNodeIds;

    if (!isObject(value)) return false;

    if (nodeIds && isObject(value)) {
      const nodeId = context.entityIdForValue(value);
      if (nodeId !== undefined) {
        nodeIds.add(nodeId);
      }
    }

    for (const field of fields) {
      if (!(field.name.value in value)) {
        complete = false;
        break;
      }
    }

    return false;
  });

  return { complete, nodeIds };
}
