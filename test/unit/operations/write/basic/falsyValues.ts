import { GraphSnapshot } from '../../../../../src/GraphSnapshot';
import { NodeId, StaticNodeId } from '../../../../../src/schema';
import { createSnapshot } from '../../../../helpers';

const { QueryRoot: QueryRootId } = StaticNodeId;

// These are really more like integration tests, given the underlying machinery.
//
// It just isn't very fruitful to unit test the individual steps of the write
// workflow in isolation, given the contextual state that must be passed around.
describe(`operations.write`, () => {
  describe(`falsy values`, () => {

    let snapshot: GraphSnapshot, editedNodeIds: Set<NodeId>;
    beforeAll(() => {
      const result = createSnapshot(
        { null: null, false: false, zero: 0, string: '' },
        `{ null, false, zero, string }`
      );

      snapshot = result.snapshot;
      editedNodeIds = result.editedNodeIds;
    });

    it(`persists all falsy values`, () => {
      expect(snapshot.getNodeData(QueryRootId)).to.deep.eq({ null: null, false: false, zero: 0, string: '' });
    });

  });
});
