//! Combining two versions of a note that both changed since they were last the same.
//! `None` means the changes overlap and the user has to choose.

use serde_json::{Map, Value};

/// Combines `ours` and `theirs`, both changed from `base`, by the rules for the kind of file.
pub fn merge_text(path: &str, base: &str, ours: &str, theirs: &str) -> Option<String> {
    if path.to_lowercase().ends_with(".canvas") {
        merge_canvas(base, ours, theirs)
    } else {
        merge_lines(base, ours, theirs)
    }
}

// ---------------------------------------------------------------------------
// Lines (Markdown and other text)
// ---------------------------------------------------------------------------

/// A three-way merge of lines: changes to different parts are both kept; a part changed
/// differently on both sides (including changes that touch, with no unchanged line between)
/// is a conflict.
pub fn merge_lines(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours == theirs || theirs == base {
        return Some(ours.to_string());
    }
    if ours == base {
        return Some(theirs.to_string());
    }
    let (b, o, t) = (lines(base), lines(ours), lines(theirs));
    let to_ours = matching(&b, &o)?;
    let to_theirs = matching(&b, &t)?;

    let mut out = String::with_capacity(ours.len().max(theirs.len()));
    let (mut i, mut j, mut k) = (0, 0, 0);
    loop {
        // The next base line that is unchanged on both sides.
        let mut s = i;
        while s < b.len() && !(to_ours[s].is_some() && to_theirs[s].is_some()) {
            s += 1;
        }
        let (j_end, k_end) = match (to_ours.get(s).copied().flatten(), to_theirs.get(s).copied().flatten()) {
            (Some(j_end), Some(k_end)) => (j_end, k_end),
            _ => (o.len(), t.len()),
        };
        if s == i && j_end == j && k_end == k {
            if s == b.len() {
                break;
            }
            out.push_str(b[i]);
            (i, j, k) = (i + 1, j + 1, k + 1);
            continue;
        }
        let (b_part, o_part, t_part) = (&b[i..s], &o[j..j_end], &t[k..k_end]);
        let taken = if o_part == b_part || o_part == t_part {
            t_part
        } else if t_part == b_part {
            o_part
        } else {
            return None;
        };
        taken.iter().for_each(|l| out.push_str(l));
        (i, j, k) = (s, j_end, k_end);
    }
    Some(out)
}

fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// For each line of `a`, the line of `b` it stays as (a longest common subsequence). `None` when
/// the texts are too different and large to compare in reasonable time; that is then a conflict.
fn matching(a: &[&str], b: &[&str]) -> Option<Vec<Option<usize>>> {
    let mut map = vec![None; a.len()];
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    for i in 0..prefix {
        map[i] = Some(i);
    }
    for n in 0..suffix {
        map[a.len() - 1 - n] = Some(b.len() - 1 - n);
    }
    let (a_mid, b_mid) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let (n, m) = (a_mid.len(), b_mid.len());
    if n == 0 || m == 0 {
        return Some(map);
    }
    if n.saturating_mul(m) > 25_000_000 {
        return None;
    }
    // lengths[i][j]: the longest common subsequence of a_mid[i..] and b_mid[j..].
    let mut lengths = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lengths[at(i, j)] = if a_mid[i] == b_mid[j] {
                lengths[at(i + 1, j + 1)] + 1
            } else {
                lengths[at(i + 1, j)].max(lengths[at(i, j + 1)])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a_mid[i] == b_mid[j] {
            map[prefix + i] = Some(prefix + j);
            i += 1;
            j += 1;
        } else if lengths[at(i + 1, j)] >= lengths[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    Some(map)
}

// ---------------------------------------------------------------------------
// Canvas (JSON Canvas: cards in `nodes`, connections in `edges`, each with an `id`)
// ---------------------------------------------------------------------------

/// Combines two canvases card by card and connection by connection. Only the same card or
/// connection changed differently on both sides is a conflict. A card edited on one side and
/// deleted on the other is kept.
pub fn merge_canvas(base: &str, ours: &str, theirs: &str) -> Option<String> {
    let parse = |text: &str| -> Option<Map<String, Value>> {
        if text.trim().is_empty() {
            return Some(Map::new());
        }
        match serde_json::from_str(text).ok()? {
            Value::Object(map) => Some(map),
            _ => None,
        }
    };
    let (b, o, t) = (parse(base)?, parse(ours)?, parse(theirs)?);

    let mut out = Map::new();
    let keys: Vec<&String> = o.keys().chain(t.keys().filter(|k| !o.contains_key(*k))).collect();
    for key in keys {
        let (bv, ov, tv) = (b.get(key), o.get(key), t.get(key));
        let value = if key == "nodes" || key == "edges" {
            let list = |v: Option<&Value>| -> Option<Vec<Value>> {
                match v {
                    None => Some(vec![]),
                    Some(Value::Array(items)) => Some(items.clone()),
                    Some(_) => None,
                }
            };
            Some(Value::Array(merge_by_id(&list(bv)?, &list(ov)?, &list(tv)?)?))
        } else if ov == tv || tv == bv {
            ov.cloned()
        } else if ov == bv {
            tv.cloned()
        } else {
            return None;
        };
        if let Some(v) = value {
            out.insert(key.clone(), v);
        }
    }

    // A connection to a card that is gone can't be drawn.
    let ids: std::collections::HashSet<String> = match out.get("nodes") {
        Some(Value::Array(nodes)) => nodes.iter().filter_map(id_of).collect(),
        _ => Default::default(),
    };
    if let Some(Value::Array(edges)) = out.get_mut("edges") {
        edges.retain(|e| {
            ["fromNode", "toNode"]
                .iter()
                .all(|end| e.get(end).and_then(Value::as_str).is_none_or(|n| ids.contains(n)))
        });
    }
    serde_json::to_string_pretty(&Value::Object(out)).ok()
}

fn id_of(item: &Value) -> Option<String> {
    item.get("id").and_then(Value::as_str).map(str::to_string)
}

fn merge_by_id(base: &[Value], ours: &[Value], theirs: &[Value]) -> Option<Vec<Value>> {
    let index = |items: &[Value]| -> Option<std::collections::HashMap<String, Value>> {
        items.iter().map(|item| id_of(item).map(|id| (id, item.clone()))).collect()
    };
    let (b, o, t) = (index(base)?, index(ours)?, index(theirs)?);
    if o.len() != ours.len() || t.len() != theirs.len() {
        return None; // The same id twice: there is no telling which is which.
    }
    let mut out = Vec::new();
    for item in ours {
        let id = id_of(item)?;
        let (bi, ti) = (b.get(&id), t.get(&id));
        match ti {
            // Removed on the other side: gone, unless it was changed here.
            None if bi == Some(item) => {}
            None => out.push(item.clone()),
            Some(ti) if ti == item || Some(ti) == bi => out.push(item.clone()),
            Some(ti) if Some(item) == bi => out.push(ti.clone()),
            Some(_) => return None,
        }
    }
    for item in theirs {
        let id = id_of(item)?;
        if o.contains_key(&id) {
            continue;
        }
        // Removed here: gone, unless it was changed on the other side.
        if b.get(&id) != Some(item) {
            out.push(item.clone());
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_to_different_lines_are_both_kept() {
        let base = "# Title\n\none\ntwo\nthree\n";
        let ours = "# Title\n\none edited\ntwo\nthree\n";
        let theirs = "# Title\n\none\ntwo\nthree edited\nfour\n";
        assert_eq!(
            merge_lines(base, ours, theirs).unwrap(),
            "# Title\n\none edited\ntwo\nthree edited\nfour\n"
        );
    }

    #[test]
    fn changes_to_the_same_line_conflict() {
        assert_eq!(merge_lines("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n"), None);
        // Changes to neighbouring lines, with no unchanged line between them, can't be placed safely.
        assert_eq!(merge_lines("a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n"), None);
        assert_eq!(merge_lines("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nc\nD\n").unwrap(), "a\nB\nc\nD\n");
    }

    #[test]
    fn the_same_change_on_both_sides_is_kept_once() {
        assert_eq!(merge_lines("a\nb\n", "a\nx\nb\n", "a\nx\nb\n").unwrap(), "a\nx\nb\n");
        assert_eq!(
            merge_lines("a\nb\nc\nd\n", "a\nX\nc\nd\n", "a\nX\nc\nD\n").unwrap(),
            "a\nX\nc\nD\n"
        );
    }

    #[test]
    fn additions_at_both_ends_and_a_missing_last_newline() {
        assert_eq!(merge_lines("m\n", "top\nm\n", "m\nbottom").unwrap(), "top\nm\nbottom");
        assert_eq!(merge_lines("a\nb\nc", "a\nb\nc\nd", "z\na\nb\nc").unwrap(), "z\na\nb\nc\nd");
    }

    #[test]
    fn deleting_lines_on_one_side_and_editing_others() {
        assert_eq!(merge_lines("a\nb\nc\nd\n", "a\nd\n", "a\nb\nc\nd\ne\n").unwrap(), "a\nd\ne\n");
    }

    fn canvas(nodes: &str, edges: &str) -> String {
        format!("{{\"nodes\":[{}],\"edges\":[{}]}}", nodes, edges)
    }

    #[test]
    fn cards_changed_on_different_devices_are_both_kept() {
        let base = canvas(r#"{"id":"a","text":"a"},{"id":"b","text":"b"}"#, "");
        let ours = canvas(r#"{"id":"a","text":"a here"},{"id":"b","text":"b"}"#, "");
        let theirs = canvas(
            r#"{"id":"a","text":"a"},{"id":"b","text":"b there"},{"id":"c","text":"new"}"#,
            r#"{"id":"e","fromNode":"a","toNode":"c"}"#,
        );
        let merged: Value = serde_json::from_str(&merge_canvas(&base, &ours, &theirs).unwrap()).unwrap();
        let texts: Vec<&str> = merged["nodes"].as_array().unwrap().iter().map(|n| n["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["a here", "b there", "new"]);
        assert_eq!(merged["edges"][0]["id"], "e");
        // Keys keep their order.
        assert_eq!(merged.as_object().unwrap().keys().collect::<Vec<_>>(), ["nodes", "edges"]);
    }

    #[test]
    fn the_same_card_changed_on_both_conflicts() {
        let base = canvas(r#"{"id":"a","x":0}"#, "");
        assert_eq!(merge_canvas(&base, &canvas(r#"{"id":"a","x":1}"#, ""), &canvas(r#"{"id":"a","x":2}"#, "")), None);
    }

    #[test]
    fn a_card_edited_here_and_deleted_there_is_kept_and_dangling_connections_go() {
        let base = canvas(r#"{"id":"a","text":"a"},{"id":"b","text":"b"}"#, r#"{"id":"e","fromNode":"a","toNode":"b"}"#);
        let ours = canvas(r#"{"id":"a","text":"a edited"},{"id":"b","text":"b"}"#, r#"{"id":"e","fromNode":"a","toNode":"b"}"#);
        let theirs = canvas(r#"{"id":"c","text":"c"}"#, r#"{"id":"f","fromNode":"c","toNode":"b"}"#);
        let merged: Value = serde_json::from_str(&merge_canvas(&base, &ours, &theirs).unwrap()).unwrap();
        let ids: Vec<&str> = merged["nodes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a", "c"]);
        assert!(merged["edges"].as_array().unwrap().is_empty());
    }
}
