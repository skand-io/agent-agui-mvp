import { useCallback, useReducer } from 'react';

export type TreeNodeId = string;

export interface TreeNode {
  id: TreeNodeId;
  value: string;
  children: TreeNode[];
  parentId?: TreeNodeId;
  categories: Set<string>;
}

export type Tree = TreeNode[];

export interface UseTreeReturn {
  tree: Tree;
  addElement: (value: string, categories: string[], parentId?: TreeNodeId) => TreeNodeId;
  printTree: (categories: string[]) => string;
  removeElement: (id: TreeNodeId) => void;
  getAllElements: () => Tree;
}

let nodeIdCounter = 0;
function randomId(): string {
  return `node_${++nodeIdCounter}_${Date.now()}`;
}

const findNode = (nodes: Tree, id: TreeNodeId): TreeNode | undefined => {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const result = findNode(node.children, id);
    if (result) {
      return result;
    }
  }
  return undefined;
};

const removeNode = (nodes: Tree, id: TreeNodeId): Tree => {
  return nodes.reduce((result: Tree, node) => {
    if (node.id !== id) {
      const newNode = { ...node, children: removeNode(node.children, id) };
      result.push(newNode);
    }
    return result;
  }, []);
};

const addNode = (nodes: Tree, newNode: TreeNode, parentId?: TreeNodeId): Tree => {
  if (!parentId) {
    return [...nodes, newNode];
  }
  return nodes.map((node) => {
    if (node.id === parentId) {
      return { ...node, children: [...node.children, newNode] };
    } else if (node.children.length) {
      return { ...node, children: addNode(node.children, newNode, parentId) };
    }
    return node;
  });
};

const treeIndentationRepresentation = (index: number, indentLevel: number): string => {
  if (indentLevel === 0) {
    return (index + 1).toString();
  } else if (indentLevel === 1) {
    return String.fromCharCode(65 + index); // 'A', 'B', 'C', ...
  } else if (indentLevel === 2) {
    return String.fromCharCode(97 + index); // 'a', 'b', 'c', ...
  } else {
    return '-';
  }
};

const printNode = (node: TreeNode, prefix = '', indentLevel = 0): string => {
  const indent = '   '.repeat(indentLevel);
  const prefixPlusIndentLength = prefix.length + indent.length;
  const subsequentLinesPrefix = ' '.repeat(prefixPlusIndentLength);

  const valueLines = node.value.split('\n');
  const outputFirstLine = `${indent}${prefix}${valueLines[0]}`;
  const outputSubsequentLines = valueLines
    .slice(1)
    .map((line) => `${subsequentLinesPrefix}${line}`)
    .join('\n');

  let output = `${outputFirstLine}\n`;
  if (outputSubsequentLines) {
    output += `${outputSubsequentLines}\n`;
  }

  const childPrePrefix = ' '.repeat(prefix.length);
  node.children.forEach((child, index) => {
    output += printNode(
      child,
      `${childPrePrefix}${treeIndentationRepresentation(index, indentLevel + 1)}. `,
      indentLevel + 1,
    );
  });

  return output;
};

function setsHaveIntersection<T>(setA: Set<T>, setB: Set<T>): boolean {
  const [smallerSet, largerSet] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const item of smallerSet) {
    if (largerSet.has(item)) {
      return true;
    }
  }
  return false;
}

// Action types
type Action =
  | { type: 'ADD_NODE'; value: string; parentId?: string; id: string; categories: string[] }
  | { type: 'REMOVE_NODE'; id: string };

// Reducer function
function treeReducer(state: Tree, action: Action): Tree {
  switch (action.type) {
    case 'ADD_NODE': {
      const { value, parentId, id: newNodeId } = action;
      const newNode: TreeNode = {
        id: newNodeId,
        value,
        children: [],
        categories: new Set(action.categories),
      };
      try {
        return addNode(state, newNode, parentId);
      } catch (error) {
        console.error(`Error while adding node with id ${newNodeId}: ${error}`);
        return state;
      }
    }
    case 'REMOVE_NODE':
      return removeNode(state, action.id);
    default:
      return state;
  }
}

// useTree hook
export function useTree(): UseTreeReturn {
  const [tree, dispatch] = useReducer(treeReducer, []);

  const addElement = useCallback(
    (value: string, categories: string[], parentId?: string): TreeNodeId => {
      const newNodeId = randomId();
      dispatch({
        type: 'ADD_NODE',
        value,
        parentId,
        id: newNodeId,
        categories,
      });
      return newNodeId;
    },
    [],
  );

  const removeElement = useCallback((id: TreeNodeId): void => {
    dispatch({ type: 'REMOVE_NODE', id });
  }, []);

  const getAllElements = useCallback(() => {
    return tree;
  }, [tree]);

  const printTree = useCallback(
    (categories: string[]): string => {
      const categoriesSet = new Set(categories);
      let output = '';

      tree.forEach((node, index) => {
        // Skip nodes that don't match any of the desired categories
        if (!setsHaveIntersection(categoriesSet, node.categories)) {
          return;
        }
        if (index !== 0) {
          output += '\n';
        }
        output += printNode(node, `${treeIndentationRepresentation(index, 0)}. `);
      });

      return output;
    },
    [tree],
  );

  return { tree, addElement, printTree, removeElement, getAllElements };
}

export default useTree;
