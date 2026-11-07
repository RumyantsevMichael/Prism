# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: 75e7768ff8206b233358be3c3d4afd6c7fb50c91
Base: be1c18d

- correctness: FINDINGS (rev-cs-correctness-1)
- ranking-and-guidance: FINDINGS (rev-cs-ranking-1)

## implementation-review: wave-2

Verified tree: 7548deb94419c75a63af81a6318a84a1ccb82e72
Base: be1c18d

- correctness: CLEAN (rev-cs-correctness-2)
- ranking-and-guidance: FINDINGS (rev-cs-ranking-2)

## implementation-review: wave-3

Verified tree: d6db70e3590e6440d7817e9fea6c02d8835dcb54
Base: be1c18d

- correctness: CLEAN (rev-cs-correctness-3)
- ranking-and-guidance: CLEAN (rev-cs-ranking-3)

## implementation-review/ranking-and-guidance/container-dropped: A merged search drops every grouped container, even when its members lead the merged list

- Status: VERIFIED
- Severity: medium
- Evidence: searchComponents sorts a result without cosineSimilarity as -Infinity, and the only such results an index returns are the outline containers that the worker (src/native-runtime/worker.mts, query) splices directly after their best member with groupedMembers. Each component answers with limit results, so when two included components each have at least limit candidates, at least limit results carry a similarity and merged.slice(0, limit) cuts every container. Scenario (run against dist searchComponents, limit 4): root/net answers [Client.get 0.91, Client (container, groupedMembers 2, cosine null), Client.post 0.88, retry 0.5] and root/app answers [fetchAll 0.7, load 0.6, save 0.55, log 0.4]; the merged result is Client.get, Client.post, fetchAll, load, with no Client, although its two members are ranks 1 and 2 and the same search scoped to packages/net returns Client at rank 2. The container also cost root/net a member slot in its own answer, so the merge hides a candidate and the slot it took, without any diagnostic. docs/user-guide/repository-intelligence.md line 100 still says that when two or more results share a container the search also returns that container, which an unscoped search in a repository with two or more components then never does once the components fill the limit; the new guide line 143 documents the trailing placement but not that it removes the container.
- Condition to close: In a merged search of two or more included components, a container that a component's index placed after one of its results sorts immediately after that result (for example by taking that result's cosineSimilarity as its sort key, with ties in index order), so the scenario above returns Client.get, Client, Client.post, fetchAll; a test through searchComponents or search_repository_concepts asserts it; and the user guide describes the placement.
- Implementer evidence: Commit b9dc9a3: searchComponents gives a result without cosineSimilarity the similarity of the result it follows in its own index as its sort key (one that follows none still sorts last), so with the stable sort a container stays directly after its best member. test/server/component-search-merge.test.mjs adds the reviewer's scenario (two components, limit 4) and asserts Client.get, Client, Client.post, fetchAll; the earlier trailing-placement test is updated to the new rule. docs/user-guide/repository-intelligence.md now says a result without a similarity stays directly after the result it follows in its component's index and counts toward limit, and that a container comes directly after the best of its grouped results.

## implementation-review/correctness/sections-list-components: get_conservation_evidence still lists a search receipt's components as a section it cannot page

- Status: VERIFIED
- Severity: low
- Evidence: The change keeps `components` in a receipt's metadata, but the refusal for a missing section still builds its list from every array field (`Object.keys(record).filter(key => Array.isArray(record[key]))`), which now includes `components`. Scenario: call get_conservation_evidence on a search receipt from a repository that declares components with section `observations`; the refusal says `Its sections are diagnostics, candidates, components`. Following that and passing section `components` is refused by the input schema, whose section enum has no `components`. Before this slice a search receipt had no array named `components`, so the list named only pageable sections.
- Condition to close: The `validation_failed` refusal for a section that a component search receipt lacks names only sections the tool accepts (it does not list `components`), and `components` still appears in the metadata of every page of that receipt.
- Implementer evidence: Commit b9dc9a3: conservation-tools.mts treats components as metadata, not a pageable section, for both the missing-section refusal list and the metadata filter. test/server/component-search-receipt.test.mjs asserts that the observations refusal on a component search receipt does not name components, that the input refuses section components, and that a candidates page still carries the receipt's components.

## implementation-review/ranking-and-guidance/guide-best-member: The user guide says a container follows the best of its grouped results, which a merged search does not do

- Status: VERIFIED
- Severity: low
- Evidence: b9dc9a3 adds to line 100 that a container comes 'directly after the best of those results'. The worker splices it after its first member in fused order, and a merged search reorders members by cosineSimilarity, so the container can follow a member that is not the best one in the merged list. Scenario (dist searchComponents, limit 10): root/net answers [A 0.5 fusedRank 1, C container null groupedMembers 2, B 0.9 fusedRank 3] and root/app answers [D 0.7]; the merged result is 1 B 0.9, 2 D 0.7, 3 A 0.5, 4 C. B, C's best member by both merged fusedRank and cosineSimilarity, is rank 1, but C is rank 4 after A, with another component's result between them. Line 143 states the actual rule correctly, so line 100 contradicts it for merged searches.
- Condition to close: docs/user-guide/repository-intelligence.md line 100 no longer claims that a container follows the best of its grouped results in a merged search, for example by saying it follows the member its index ranked first, or by dropping the placement there and leaving it to the merged-search paragraph; the scenario's result is consistent with every guide sentence.
- Implementer evidence: Commit 74f4c02: docs/user-guide/repository-intelligence.md line 100 now says the container comes directly after the one of its grouped results that their index ranks first, which is where the worker splices it (after the first member in its fused order). In a merged search line 143 keeps it directly after the result it follows in its component's index, which is that same member, so the reviewer's scenario (C after A, not after B) is consistent with both sentences. Lines 140-147 are unchanged.

