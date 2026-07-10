import Foundation

struct RewriteSnapshot: Equatable {
    let before: String
    let after: String
}

enum RewriteUndoHelper {
    static func replace(before: String, with after: String, deleteBackward: () -> Void, insert: (String) -> Void) {
        before.forEach { _ in deleteBackward() }
        insert(after)
    }

    static func undo(_ snapshot: RewriteSnapshot, currentBeforeCursor: String,
                     deleteBackward: () -> Void, insert: (String) -> Void) -> Bool {
        guard currentBeforeCursor.hasSuffix(snapshot.after) else { return false }
        snapshot.after.forEach { _ in deleteBackward() }
        insert(snapshot.before)
        return true
    }
}
