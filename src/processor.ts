import { MarkdownPostProcessorContext } from "obsidian"
import { createProxy, IJiraIssue, IJiraSearchResults } from "./interfaces"
import { JiraClient } from "./jiraClient"
import { ObjectsCache } from "./objectsCache"
import { ESearchColumnsTypes, ESearchResultsRenderingTypes, SearchView, SEARCH_COLUMNS_DESCRIPTION } from "./searchView"
import { IJiraIssueSettings } from "./settings"

const COMMENT_REGEX = /^\s*#/
const ISSUE_REGEX = /^\s*([A-Z0-9]+-[0-9]+)\s*$/i
const ISSUE_LINK_REGEX = /\/([A-Z0-9]+-[0-9]+)\s*$/i
const JIRA_STATUS_COLOR_MAP: Record<string, string> = {
    'blue-gray': 'is-info',
    'yellow': 'is-warning',
    'green': 'is-success',
    'red': 'is-danger',
    'medium-gray': 'is-dark',
}
const DESCRIPTION_COMPACT_MAX_LENGTH = 20

function dateToStr(fullDate: string): string {
    if (fullDate) {
        const d = new Date(fullDate)
        return d.toLocaleDateString()
    }
    return fullDate
}

export class JiraIssueProcessor {
    private _settings: IJiraIssueSettings
    private _client: JiraClient
    private _cache: ObjectsCache

    constructor(settings: IJiraIssueSettings, client: JiraClient, cache: ObjectsCache) {
        this._settings = settings
        this._client = client
        this._cache = cache
    }

    async issueFence(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
        const renderedItems: Record<string, HTMLElement> = {}
        for (const line of source.split('\n')) {
            const issueKey = this.getIssueKey(line)
            if (issueKey) {
                // console.log(`Issue found: ${issueKey}`)
                let issue: IJiraIssue = this._cache.get(issueKey)
                if (!issue) {
                    // console.log(`Issue not available in the cache`)
                    renderedItems[issueKey] = this.renderLoadingItem(issueKey, this.issueUrl(issueKey))
                    this._client.getIssue(issueKey).then(newIssue => {
                        issue = this._cache.add(issueKey, newIssue)
                        renderedItems[issueKey] = this.renderIssue(issue)
                        this.updateRenderedIssues(el, renderedItems)
                    }).catch(err => {
                        renderedItems[issueKey] = this.renderIssueError(issueKey, err)
                        this.updateRenderedIssues(el, renderedItems)
                    })
                } else {
                    renderedItems[issueKey] = this.renderIssue(issue)
                }
            }
        }
        this.updateRenderedIssues(el, renderedItems)
    }

    async searchResultsFence(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
        // console.log(`Search query: ${source}`)
        try {

            const searchView = new SearchView().fromString(source)
            let searchResults: IJiraSearchResults = this._cache.get(searchView.query + searchView.limit)
            if (!searchResults) {
                // console.log(`Search results not available in the cache`)
                this.renderLoadingItem('View in browser', this.searchUrl(searchView.query))
                this._client.getSearchResults(searchView.query, parseInt(searchView.limit) || this._settings.searchResultsLimit)
                    .then(newSearchResults => {
                        searchResults = this._cache.add(searchView.query + searchView.limit, newSearchResults)
                        this.renderSearchResults(el, searchView, searchResults)
                    }).catch(err => {
                        this.renderSearchError(el, err, searchView)
                    })
            } else {
                this.renderSearchResults(el, searchView, searchResults)
            }
        } catch (err) {
            this.renderSearchError(el, err, null)
        }
    }

    async searchCountFence(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
        // console.log(`Search query: ${source}`)
        let searchResults: IJiraSearchResults = this._cache.get(source)
        if (!searchResults) {
            // console.log(`Search results not available in the cache`)
            this.renderLoadingItem('View in browser', this.searchUrl(source))
            this._client.getSearchResults(source, -1).then(newSearchResults => {
                searchResults = this._cache.add(source, newSearchResults)
                this.renderSearchCount(el, searchResults.total, source)
            }).catch(err => {
                this.renderSearchError(el, source, err)
            })
        } else {
            this.renderSearchCount(el, searchResults.total, source)
        }
    }

    async issueInline(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        console.log({ el, ctx })
    }

    private getIssueKey(line: string): string | null {
        if (COMMENT_REGEX.test(line)) {
            return null
        }
        const matches = line.match(ISSUE_REGEX)
        if (matches) {
            return matches[1]
        }
        const matchesLink = line.match(ISSUE_LINK_REGEX)
        if (matchesLink) {
            return matchesLink[1]
        }
        return null
    }

    private updateRenderedIssues(el: HTMLElement, renderedItems: Record<string, HTMLElement>): void {
        if (!Object.isEmpty(renderedItems)) {
            el.replaceChildren(this.renderContainer(Object.values(renderedItems)))
        } else {
            el.replaceChildren(this.renderContainer([this.renderNoItems()]))
        }
    }

    private renderSearchResults(el: HTMLElement, searchView: SearchView, searchResults: IJiraSearchResults): void {
        if (searchView.type === ESearchResultsRenderingTypes.LIST) {
            this.renderSearchResultsList(el, searchResults)
        } else {
            this.renderSearchResultsTable(el, searchView, searchResults)
        }
    }

    private renderSearchCount(el: HTMLElement, searchResultsCount: number, query: string): void {
        const tagsRow = createDiv('ji-tags has-addons')
        createSpan({ cls: `ji-tag is-link ${this.getTheme()}`, text: `Count`, title: query, parent: tagsRow })
        createSpan({ cls: `ji-tag ${this.getTheme()}`, text: searchResultsCount.toString(), title: query, parent: tagsRow })
        el.replaceChildren(this.renderContainer([tagsRow]))
    }

    private issueUrl(issueKey: string): string {
        return (new URL(`${this._settings.host}/browse/${issueKey}`)).toString()
    }

    private searchUrl(searchQuery: string): string {
        // TODO: find real url for search
        return (new URL(`${this._settings.host}/issues?jql${searchQuery}`)).toString()
    }

    private getTheme(): string {
        return this._settings.darkMode ? 'is-dark' : 'is-light'
    }

    private renderContainer(children: HTMLElement[]): HTMLElement {
        const container = createDiv({ cls: 'jira-issue-container' })
        for (const child of children) {
            container.appendChild(child)
        }
        return container
    }

    private renderLoadingItem(item: string, itemUrl: string): HTMLElement {
        const tagsRow = createDiv('ji-tags has-addons')
        createSpan({ cls: 'spinner', parent: createSpan({ cls: `ji-tag ${this.getTheme()}`, parent: tagsRow }) })
        createEl('a', { cls: `ji-tag is-link ${this.getTheme()}`, href: itemUrl, text: item, parent: tagsRow })
        createSpan({ cls: `ji-tag ${this.getTheme()}`, text: 'Loading ...', parent: tagsRow })
        return tagsRow
    }

    private renderNoItems(): HTMLElement {
        const tagsRow = createDiv('ji-tags has-addons')
        createSpan({ cls: 'ji-tag is-danger is-light', text: 'JiraIssue', parent: tagsRow })
        createSpan({ cls: 'ji-tag is-danger', text: 'No valid issues found', parent: tagsRow })
        return tagsRow
    }

    private renderIssue(issue: IJiraIssue): HTMLElement {
        const tagsRow = createDiv('ji-tags has-addons')
        createEl('img', {
            cls: 'fit-content',
            attr: { src: issue.fields.issuetype.iconUrl, alt: issue.fields.issuetype.name },
            title: issue.fields.issuetype.name,
            parent: createSpan({ cls: `ji-tag ${this.getTheme()}`, parent: tagsRow })
        })
        createEl('a', { cls: `ji-tag is-link ${this.getTheme()} no-wrap`, href: this.issueUrl(issue.key), text: issue.key, parent: tagsRow })
        createSpan({ cls: `ji-tag ${this.getTheme()} issue-summary`, text: issue.fields.summary, parent: tagsRow })
        const statusColor = JIRA_STATUS_COLOR_MAP[issue.fields.status.statusCategory.colorName] || 'is-light'
        createSpan({ cls: `ji-tag no-wrap ${statusColor}`, text: issue.fields.status.name, title: issue.fields.status.description, parent: tagsRow })
        return tagsRow
    }

    private renderIssueError(issueKey: string, message: string): HTMLElement {
        const tagsRow = createDiv('ji-tags has-addons')
        createSpan({ cls: 'ji-tag is-delete is-danger', parent: tagsRow })
        createEl('a', { cls: 'ji-tag is-danger is-light', href: this.issueUrl(issueKey), text: issueKey, parent: tagsRow })
        createSpan({ cls: 'ji-tag is-danger', text: message, parent: tagsRow })
        return tagsRow
    }

    private renderSearchResultsTable(el: HTMLElement, searchView: SearchView, searchResults: IJiraSearchResults): void {
        const table = createEl('table', { cls: `table is-bordered is-striped is-narrow is-hoverable is-fullwidth ${this.getTheme()}` })
        this.renderSearchResultsTableHeader(table, searchView)
        this.renderSearchResultsTableBody(table, searchResults, searchView)
        const statistics = createSpan({ cls: 'statistics', text: `Total results: ${searchResults.total.toString()} - Last update: ${this._cache.getTime(searchView.query + searchView.limit)}` })
        el.replaceChildren(this.renderContainer([table, statistics]))
    }

    private renderSearchResultsTableHeader(table: HTMLElement, searchView: SearchView): void {
        const header = createEl('tr', { parent: createEl('thead', { parent: table }) })
        const columns = searchView.columns.length > 0 ? searchView.columns : this._settings.searchColumns
        for (const column of columns) {
            // const name = column.type !== ESearchColumnsTypes.CUSTOM ? SEARCH_COLUMNS_DESCRIPTION[column.type] : column.customField
            const name = SEARCH_COLUMNS_DESCRIPTION[column.type]
            if (column.compact) {
                createEl('abbr', { text: name[0].toUpperCase(), title: name, parent: createEl('th', { parent: header }) })
            } else {
                createEl('th', { text: name, parent: header })
            }
        }
    }

    private renderSearchResultsTableBody(table: HTMLElement, searchResults: IJiraSearchResults, searchView: SearchView): void {
        const tbody = createEl('tbody', { parent: table })
        for (let issue of searchResults.issues) {
            issue = createProxy(issue)
            const row = createEl('tr', { parent: tbody })
            const columns = searchView.columns.length > 0 ? searchView.columns : this._settings.searchColumns
            for (const column of columns) {
                switch (column.type) {
                    case ESearchColumnsTypes.KEY:
                        createEl('a', {
                            cls: 'no-wrap',
                            href: this.issueUrl(issue.key),
                            text: column.compact ? '🔗' : issue.key,
                            title: column.compact ? issue.key : '',
                            parent: createEl('td', { parent: row })
                        })
                        break
                    case ESearchColumnsTypes.SUMMARY:
                        if (column.compact) {
                            let summaryCompact = issue.fields.summary.substring(0, DESCRIPTION_COMPACT_MAX_LENGTH)
                            if (issue.fields.summary.length > DESCRIPTION_COMPACT_MAX_LENGTH) {
                                summaryCompact += '…'
                            }
                            createEl('td', { text: summaryCompact, title: issue.fields.summary, parent: row })
                        } else {
                            createEl('td', { text: issue.fields.summary, parent: row })
                        }
                        break
                    case ESearchColumnsTypes.TYPE:
                        const typeCell = createEl('td', { parent: row })
                        createEl('img', {
                            attr: { src: issue.fields.issuetype.iconUrl, alt: issue.fields.issuetype.name },
                            title: column.compact ? issue.fields.issuetype.name : '',
                            cls: 'letter-height',
                            parent: typeCell
                        })
                        if (!column.compact) {
                            createSpan({ text: ' ' + issue.fields.issuetype.name, parent: typeCell })
                        }
                        break
                    case ESearchColumnsTypes.CREATED:
                        if (column.compact) {
                            createEl('td', { text: '🕑', title: dateToStr(issue.fields.created), parent: row })
                        } else {
                            createEl('td', { text: dateToStr(issue.fields.created), parent: row })
                        }
                        break
                    case ESearchColumnsTypes.UPDATED:
                        if (column.compact) {
                            createEl('td', { text: '🕑', title: dateToStr(issue.fields.updated), parent: row })
                        } else {
                            createEl('td', { text: dateToStr(issue.fields.updated), parent: row })
                        }
                        break
                    case ESearchColumnsTypes.REPORTER:
                        const reporterName = issue.fields.reporter.displayName || ''
                        if (column.compact && reporterName) {
                            createEl('img', {
                                attr: { src: issue.fields.reporter.avatarUrls['16x16'], alt: reporterName },
                                title: reporterName,
                                cls: 'avatar-image',
                                parent: createEl('td', { parent: row })
                            })
                        } else {
                            createEl('td', { text: reporterName, parent: row })
                        }
                        break
                    case ESearchColumnsTypes.ASSIGNEE:
                        const assigneeName = issue.fields.assignee.displayName || ''
                        if (column.compact && assigneeName) {
                            createEl('img', {
                                attr: { src: issue.fields.assignee.avatarUrls['16x16'], alt: assigneeName },
                                title: assigneeName,
                                cls: 'avatar-image',
                                parent: createEl('td', { parent: row })
                            })
                        } else {
                            createEl('td', { text: assigneeName, parent: row })
                        }
                        break
                    case ESearchColumnsTypes.PRIORITY:
                        const priorityCell = createEl('td', { parent: row })
                        createEl('img', {
                            attr: { src: issue.fields.priority.iconUrl, alt: issue.fields.priority.name },
                            title: column.compact ? issue.fields.priority.name : '',
                            cls: 'letter-height',
                            parent: priorityCell
                        })
                        if (!column.compact) {
                            createSpan({ text: ' ' + issue.fields.priority.name, parent: priorityCell })
                        }
                        break
                    case ESearchColumnsTypes.STATUS:
                        const statusColor = JIRA_STATUS_COLOR_MAP[issue.fields.status.statusCategory.colorName] || 'is-light'
                        if (column.compact) {
                            createSpan({ cls: `ji-tag no-wrap ${statusColor}`, text: issue.fields.status.name[0].toUpperCase(), title: issue.fields.status.name, parent: createEl('td', { parent: row }) })
                        } else {
                            createSpan({ cls: `ji-tag no-wrap ${statusColor}`, text: issue.fields.status.name, title: issue.fields.status.description, parent: createEl('td', { parent: row }) })
                        }
                        break
                    case ESearchColumnsTypes.DUE_DATE:
                        if (column.compact) {
                            createEl('td', { text: '🕑', title: dateToStr(issue.fields.duedate), parent: row })
                        } else {
                            createEl('td', { text: dateToStr(issue.fields.duedate), parent: row })
                        }
                        break
                    case ESearchColumnsTypes.RESOLUTION:
                        if (issue.fields.resolution.description) {
                            createEl('abbr', { text: issue.fields.resolution.name, title: issue.fields.resolution.description, parent: createEl('td', { parent: row }) })
                        } else {
                            createEl('td', { text: issue.fields.resolution.name, title: issue.fields.resolution.description, parent: row })
                        }
                        break
                    case ESearchColumnsTypes.RESOLUTION_DATE:
                        if (column.compact) {
                            createEl('td', { text: '🕑', title: dateToStr(issue.fields.resolutiondate), parent: row })
                        } else {
                            createEl('td', { text: dateToStr(issue.fields.resolutiondate), parent: row })
                        }
                        break
                    case ESearchColumnsTypes.ENVIRONMENT:
                        if (column.compact) {
                            let environmentCompact = issue.fields.environment.substring(0, DESCRIPTION_COMPACT_MAX_LENGTH)
                            if (issue.fields.environment.length > DESCRIPTION_COMPACT_MAX_LENGTH) {
                                environmentCompact += '…'
                            }
                            createEl('td', { text: environmentCompact, title: issue.fields.environment, parent: row })
                        } else {
                            createEl('td', { text: issue.fields.environment, parent: row })
                        }
                        break
                    case ESearchColumnsTypes.PROJECT:
                        createEl('td', { text: issue.fields.project.key, title: issue.fields.project.name, parent: row })
                        break
                    // case ESearchColumnsTypes.CUSTOM:
                    //     break
                }
            }
        }
    }

    private renderSearchResultsList(el: HTMLElement, searchResults: IJiraSearchResults): void {
        const list: HTMLElement[] = []
        for (const issue of searchResults.issues) {
            list.push(this.renderIssue(issue))
        }
        el.replaceChildren(this.renderContainer(list))
    }

    private renderSearchError(el: HTMLElement, message: string, searchView: SearchView): void {
        const tagsRow = createDiv('ji-tags has-addons')
        createSpan({ cls: 'ji-tag is-delete is-danger', parent: tagsRow })
        if (searchView) {
            createEl('a', { cls: `ji-tag is-danger ${this.getTheme()}`, href: this.searchUrl(searchView.query), text: "Search error", parent: tagsRow })
        } else {
            createSpan({ cls: `ji-tag is-danger ${this.getTheme()}`, text: "Search error", parent: tagsRow })
        }
        createSpan({ cls: 'ji-tag is-danger', text: message, parent: tagsRow })
        el.replaceChildren(this.renderContainer([tagsRow]))
    }
}