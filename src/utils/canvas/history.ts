import { CanvasData } from "../../types/canvas";

export class CanvasHistory {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private maxStackSize: number;

  constructor(maxStackSize = 50) {
    this.maxStackSize = maxStackSize;
  }

  /**
   * Records a new state onto the undo stack, clearing redo stack
   */
  public pushState(data: CanvasData): void {
    const serialized = JSON.stringify({ nodes: data.nodes, edges: data.edges });
    if (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1] === serialized) {
      return; // Deduplicate identical consecutive states
    }
    this.undoStack.push(serialized);
    if (this.undoStack.length > this.maxStackSize) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /**
   * Reverts to the previous state
   */
  public undo(currentState: CanvasData): CanvasData | null {
    if (this.undoStack.length === 0) return null;

    const currentSerialized = JSON.stringify({ nodes: currentState.nodes, edges: currentState.edges });
    const previousSerialized = this.undoStack.pop()!;

    // If the top of undo matches current state (common when pushing before changes), pop again
    if (previousSerialized === currentSerialized) {
      if (this.undoStack.length === 0) {
        this.undoStack.push(previousSerialized);
        return null;
      }
      const actualPrevious = this.undoStack.pop()!;
      this.redoStack.push(currentSerialized);
      const parsed = JSON.parse(actualPrevious);
      return { ...currentState, nodes: parsed.nodes, edges: parsed.edges };
    }

    this.redoStack.push(currentSerialized);
    const parsed = JSON.parse(previousSerialized);
    return { ...currentState, nodes: parsed.nodes, edges: parsed.edges };
  }

  /**
   * Re-applies an undone state
   */
  public redo(currentState: CanvasData): CanvasData | null {
    if (this.redoStack.length === 0) return null;

    const nextSerialized = this.redoStack.pop()!;
    const currentSerialized = JSON.stringify({ nodes: currentState.nodes, edges: currentState.edges });
    this.undoStack.push(currentSerialized);

    const parsed = JSON.parse(nextSerialized);
    return { ...currentState, nodes: parsed.nodes, edges: parsed.edges };
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
