// GitHub GraphQL API クライアント。
// 「1リポジトリのオープンPR + 最新コミットのチェック結果 + レビュー」を1クエリで取る。
// 取得したい項目を増やしたいときは PR_QUERY の GraphQL を編集し、
// 整形は src/summarize.mjs 側で行う（このファイルは通信と生データの責務だけ）。

const ENDPOINT = 'https://api.github.com/graphql';

const PR_QUERY = /* GraphQL */ `
  query PullRequests($owner: String!, $name: String!, $first: Int!, $cursor: String) {
    viewer {
      login
    }
    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
    repository(owner: $owner, name: $name) {
      nameWithOwner
      url
      pullRequests(
        states: OPEN
        first: $first
        after: $cursor
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          url
          isDraft
          createdAt
          updatedAt
          additions
          deletions
          changedFiles
          mergeable
          baseRefName
          headRefName
          author {
            login
            avatarUrl(size: 48)
          }
          labels(first: 20) {
            nodes {
              name
              color
            }
          }
          comments {
            totalCount
          }
          reviewDecision
          reviewRequests(first: 20) {
            nodes {
              requestedReviewer {
                __typename
                ... on User {
                  login
                  avatarUrl(size: 48)
                }
                ... on Bot {
                  login
                  avatarUrl(size: 48)
                }
                ... on Mannequin {
                  login
                  avatarUrl(size: 48)
                }
                ... on Team {
                  name
                }
              }
            }
          }
          latestReviews(first: 30) {
            nodes {
              state
              submittedAt
              url
              author {
                login
                avatarUrl(size: 48)
              }
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                oid
                committedDate
                messageHeadline
                statusCheckRollup {
                  state
                  contexts(first: 100) {
                    totalCount
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        status
                        conclusion
                        detailsUrl
                        startedAt
                        completedAt
                        checkSuite {
                          workflowRun {
                            event
                            url
                            workflow {
                              name
                            }
                          }
                        }
                      }
                      ... on StatusContext {
                        context
                        state
                        description
                        targetUrl
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export async function graphql(token, query, variables) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-pr-checker',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401) {
    throw new Error('GitHub の認証に失敗しました (401)。`gh auth login` でログインし直してください。');
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GitHub API の応答を解釈できませんでした (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  if (payload.errors?.length) {
    // NOT_FOUND などは呼び出し側で扱えるように type を残す
    const error = new Error(payload.errors.map((e) => e.message).join(' / '));
    error.graphqlErrors = payload.errors;
    throw error;
  }
  if (!response.ok) {
    throw new Error(`GitHub API がエラーを返しました (HTTP ${response.status})`);
  }

  return payload.data;
}

/**
 * 1リポジトリのオープンPRを（必要ならページングして）全部取る。
 * @returns {{ repository: object, pullRequests: object[], viewer: string, rateLimit: object }}
 */
export async function fetchRepoPullRequests(token, repo, { maxPrs = 100 } = {}) {
  const pullRequests = [];
  let cursor = null;
  let repository = null;
  let viewer = null;
  let rateLimit = null;
  let totalCount = 0;

  while (pullRequests.length < maxPrs) {
    const first = Math.min(50, maxPrs - pullRequests.length);
    const data = await graphql(token, PR_QUERY, {
      owner: repo.owner,
      name: repo.name,
      first,
      cursor,
    });

    viewer = data.viewer?.login ?? viewer;
    rateLimit = data.rateLimit ?? rateLimit;
    if (!data.repository) {
      throw new Error(`リポジトリ ${repo.nameWithOwner} が見つかりません（権限不足の可能性があります）`);
    }
    repository = { nameWithOwner: data.repository.nameWithOwner, url: data.repository.url };
    totalCount = data.repository.pullRequests.totalCount;

    pullRequests.push(...data.repository.pullRequests.nodes);

    const pageInfo = data.repository.pullRequests.pageInfo;
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return { repository, pullRequests, totalCount, viewer, rateLimit };
}
