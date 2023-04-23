const github = require('@actions/github')
const core = require('@actions/core')
const _ = require('lodash')
const cc = require('@conventional-commits/parser')
require('cross-fetch/polyfill');

const types = [
  { types: ['feat', 'feature'], header: 'New Features', icon: ':sparkles:' },
  { types: ['fix', 'bugfix'], header: 'Bug Fixes', icon: ':bug:', relIssuePrefix: 'fixes' },
  { types: ['perf'], header: 'Performance Improvements', icon: ':zap:' },
  { types: ['refactor'], header: 'Refactors', icon: ':recycle:' },
  { types: ['test', 'tests'], header: 'Tests', icon: ':white_check_mark:' },
  { types: ['build', 'ci'], header: 'Build System', icon: ':construction_worker:' },
  { types: ['doc', 'docs'], header: 'Documentation Changes', icon: ':memo:' },
  { types: ['style'], header: 'Code Style Changes', icon: ':art:' },
  { types: ['chore'], header: 'Chores', icon: ':wrench:' },
  { types: ['other'], header: 'Other Changes', icon: ':flying_saucer:' }
]

async function main () {
  const token = core.getInput('token')
  const tag = core.getInput('tag')
  const fromTag = core.getInput('fromTag')
  const toTag = core.getInput('toTag')
  const title = core.getInput('title')
  const slackBotToken = core.getInput('slackBotToken')
  const slackChannelIds = (core.getInput('slackChannelId') || '').split(',').map(t => t.trim())
  const excludeTypes = (core.getInput('excludeTypes') || '').split(',').map(t => t.trim())
  const includeInvalidCommits = core.getBooleanInput('includeInvalidCommits')
  const reverseOrder = core.getBooleanInput('reverseOrder')
  const gh = github.getOctokit(token)
  const owner = github.context.repo.owner
  const repo = github.context.repo.repo

  let latestTag = null
  let previousTag = null

  if (tag && (fromTag || toTag)) {
    return core.setFailed(`Must provide EITHER input tag OR (fromTag and toTag), not both!`)
  } else if (tag) {

    // GET LATEST + PREVIOUS TAGS

    core.info(`Using input tag: ${tag}`)

    const tagsRaw = await gh.graphql(`
      query lastTags ($owner: String!, $repo: String!) {
        repository (owner: $owner, name: $repo) {
          refs(first: 2, refPrefix: "refs/tags/", orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
            nodes {
              name
              target {
                oid
              }
            }
          }
        }
      }
    `, {
      owner,
      repo
    })

    latestTag = _.get(tagsRaw, 'repository.refs.nodes[0]')
    previousTag = _.get(tagsRaw, 'repository.refs.nodes[1]')

    if (!latestTag) {
      return core.setFailed('Couldn\'t find the latest tag. Make sure you have an existing tag already before creating a new one.')
    }
    if (!previousTag) {
      return core.setFailed('Couldn\'t find a previous tag. Make sure you have at least 2 tags already (current tag + previous initial tag).')
    }

    if (latestTag.name !== tag) {
      return core.setFailed(`Provided tag doesn\'t match latest tag ${tag}.`)
    }

    core.info(`Using latest tag: ${latestTag.name}`)
    core.info(`Using previous tag: ${previousTag.name}`)
  } else if (fromTag && toTag) {

    // GET FROM + TO TAGS FROM INPUTS

    latestTag = { name: fromTag }
    previousTag = { name: toTag }

    core.info(`Using tag range: ${fromTag} to ${toTag}`)
  } else {
    return core.setFailed(`Must provide either input tag OR (fromTag and toTag). None were provided!`)
  }

  // GET COMMITS

  let curPage = 0
  let totalCommits = 0
  let hasMoreCommits = false
  const commits = []
  do {
    hasMoreCommits = false
    curPage++
    const commitsRaw = await gh.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${previousTag.name}...${latestTag.name}`,
      page: curPage,
      per_page: 100
    })
    totalCommits = _.get(commitsRaw, 'data.total_commits', 0)
    const rangeCommits = _.get(commitsRaw, 'data.commits', [])
    commits.push(...rangeCommits)
    if ((curPage - 1) * 100 + rangeCommits.length < totalCommits) {
      hasMoreCommits = true
    }
  } while (hasMoreCommits)

  if (!commits || commits.length < 1) {
    return core.setFailed('Couldn\'t find any commits between latest and previous tags.')
  }

  // PARSE COMMITS

  const commitsParsed = []
  const breakingChanges = []
  for (const commit of commits) {
    try {
      const cAst = cc.toConventionalChangelogFormat(cc.parser(commit.commit.message))
      commitsParsed.push({
        ...cAst,
        type: cAst.type.toLowerCase(),
        sha: commit.sha,
        url: commit.html_url,
        author: _.get(commit, 'author.login'),
        authorUrl: _.get(commit, 'author.html_url')
      })
      for (const note of cAst.notes) {
        if (note.title === 'BREAKING CHANGE') {
          breakingChanges.push({
            sha: commit.sha,
            url: commit.html_url,
            subject: cAst.subject,
            author: _.get(commit, 'author.login'),
            authorUrl: _.get(commit, 'author.html_url'),
            text: note.text
          })
        }
      }
      core.info(`[OK] Commit ${commit.sha} of type ${cAst.type} - ${cAst.subject}`)
    } catch (err) {
      if (includeInvalidCommits) {
        commitsParsed.push({
          type: 'other',
          subject: commit.commit.message,
          sha: commit.sha,
          url: commit.html_url,
          author: _.get(commit, 'author.login'),
          authorUrl: _.get(commit, 'author.html_url')
        })
        core.info(`[OK] Commit ${commit.sha} with invalid type, falling back to other - ${commit.commit.message}`)
      } else {
        core.info(`[INVALID] Skipping commit ${commit.sha} as it doesn't follow conventional commit format.`)
      }
    }
  }

  // if (commitsParsed.length < 1) {
  //   return core.setFailed('No valid commits parsed since previous tag.')
  // }

  if (reverseOrder) {
    commitsParsed.reverse()
  }

  // BUILD CHANGELOG

  const changesFile = []
  const changesVar = []
  const slackBlocks = []

  if (title != "") {
    slackBlocks.push({
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": title,
        "emoji": true
      }
    })
  }

  let idx = 0

  if (breakingChanges.length > 0) {
    slackBlocks.push({
      "type": "section",
			"text": {
				"type": "mrkdwn",
				"text": ":boom: *BREAKING CHANGES*"
			}
    })
    
    for (const breakChange of breakingChanges) {
      const text = breakChange.author ? `${breakChange.subject} *(by @${breakChange.author})*` : `${breakChange.subject}`
      slackBlocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": text
        }
      })
    }
    idx++
  }

  for (const type of types) {
    if (_.intersection(type.types, excludeTypes).length > 0) {
      continue
    }
    const matchingCommits = commitsParsed.filter(c => type.types.includes(c.type))
    if (matchingCommits.length < 1) {
      continue
    }
    if (idx > 0) {
      slackBlocks.push({
        "type": "divider"
      })
    }

    slackBlocks.push({
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": `${type.icon} *${type.header}*`
      }
    })

    for (const commit of matchingCommits) {
      const slackScope = commit.scope ? `*${commit.scope}*: ` : ''
      const text = commit.author ? `${slackScope}${commit.subject} by ${commit.author} ${commit.sha.substring(0, 7)}` : `${slackScope}${commit.subject} ${commit.sha.substring(0, 7)}`
      slackBlocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": text
        }
      })
    }
    idx++
  }

  const payload = { 
    'text': title,
    'blocks': slackBlocks
  }

  core.info(`payload: ${JSON.stringify(payload)}`)

  if (slackBotToken.length > 0 && slackChannelIds.length > 0) {
    await Promise.all(slackChannelIds.map(async (channelId) => {
      const body = {
        channel: channelId,
        ...(payload || {})
      }
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: "POST",
        headers: { 
          'Authorization': `Bearer ${slackBotToken}`,
          "Content-Type": "application/json",
         },
        body: body,
      })
      const resdata = await res.text()
      if (res.status != 200) {
        core.setFailed(resdata)
      } else {
        core.info(resdata)
      }
    }))
  } else {
    core.setOutput('payload', JSON.stringify(payload))
  }
}

main()
