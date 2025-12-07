const NodeHelper = require("node_helper");
const https = require("https");

module.exports = NodeHelper.create({
  start: function () {
    console.log("Starting node helper for: " + this.name);
    this.config = null;
    this.lastSuccessfulData = null;
    this.retryTimeout = null;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "SENTRY_CONFIG") {
      this.config = payload;
      this.fetchSentryIssues();
    } else if (notification === "SENTRY_FETCH") {
      if (this.config) {
        this.fetchSentryIssues();
      }
    }
  },

  /**
   * Main method to fetch issues from Sentry API
   */
  fetchSentryIssues: function () {
    // Validate configuration
    if (!this.config || !this.config.sentryAuthToken || !this.config.sentryOrgSlug) {
      this.sendSocketNotification("SENTRY_ERROR", {
        error: "Missing required configuration: sentryAuthToken or sentryOrgSlug"
      });
      return;
    }

    const { sentryOrgSlug, sentryAuthToken, sortBy, timeRange, displayCount } = this.config;

    // Build query parameters
    const queryParams = new URLSearchParams({
      query: "is:unresolved",
      sort: sortBy === "freq" ? "freq" : "", // TODO: add other sort options
      statsPeriod: timeRange || "24h"
    });

    console.log(`[MMM-Sentry-Monitoring] Query Params: ${queryParams.toString()}`);

    const url = `/api/0/organizations/${sentryOrgSlug}/issues/?${queryParams.toString()}`;

    const options = {
      hostname: "sentry.io",
      port: 443,
      path: url,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${sentryAuthToken}`,
        "Content-Type": "application/json"
      }
    };

    console.log(`[MMM-Sentry-Monitoring] Fetching issues from Sentry...`);

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const rawData = JSON.parse(data);
            const formattedData = this.formatIssueData(rawData);

            // Cache successful response
            this.lastSuccessfulData = formattedData;

            this.sendSocketNotification("SENTRY_UPDATE", formattedData);
            console.log(`[MMM-Sentry-Monitoring] Successfully fetched ${formattedData.issues.length} issues`);
          } catch (err) {
            console.error("[MMM-Sentry-Monitoring] Error parsing Sentry response:", err);
            this.handleError("Failed to parse Sentry response");
          }
        } else if (res.statusCode === 401) {
          console.error("[MMM-Sentry-Monitoring] Unauthorized: Invalid auth token");
          this.handleError("Invalid Sentry auth token (401 Unauthorized)");
        } else if (res.statusCode === 404) {
          console.error("[MMM-Sentry-Monitoring] Not found: Invalid organization or project");
          this.handleError("Invalid organization or project (404 Not Found)");
        } else if (res.statusCode === 429) {
          console.error("[MMM-Sentry-Monitoring] Rate limit exceeded");
          this.handleError("Sentry API rate limit exceeded. Retrying in 60 seconds...");
          // Retry after longer delay for rate limiting
          this.scheduleRetry(60000);
        } else {
          console.error(`[MMM-Sentry-Monitoring] Sentry API error: ${res.statusCode}`);
          this.handleError(`Sentry API error: ${res.statusCode} ${res.statusMessage}`);
        }
      });
    });

    req.on("error", (err) => {
      console.error("[MMM-Sentry-Monitoring] Network error:", err.message);
      this.handleError(`Network error: ${err.message}`);
      this.scheduleRetry(5000); // Retry after 5 seconds on network error
    });

    req.end();
  },

  /**
   * Format raw Sentry API response into structured data
   */
  formatIssueData: function (rawData) {
    if (!Array.isArray(rawData)) {
      throw new Error("Expected array from Sentry API");
    }

    // Calculate total events count for percentage calculation
    const totalCount = rawData.reduce((sum, issue) => {
      return sum + (Number(issue.count) || 0);
    }, 0);

    // Apply filters and format issues
    const issues = rawData
      .filter(issue => (issue.count || 0) >= (this.config.minEvents || 1))
      .slice(0, this.config.displayCount || 5)
      .map(issue => {
        const count = issue.count || 0;
        const users = issue.userCount || 0;
        const level = issue.level || "error";
        const project = issue.project.slug || "unknown";

        return {
          id: issue.id || "",
          title: issue.title || issue.metadata?.title || "Unknown error",
          shortTitle: this.truncateText(issue.title || issue.metadata?.title || "Unknown error", 80),
          level: level,
          count: count,
          users: users,
          project: project,
          firstSeen: issue.firstSeen || null,
          lastSeen: issue.lastSeen || null,
          timeAgo: this.formatTimeAgo(issue.lastSeen),
          percentage: this.calculatePercentage(count, totalCount),
          url: issue.permalink || `https://sentry.io/organizations/${this.config.sentryOrgSlug}/issues/${issue.id}/`,
          isRegression: issue.isRegression || false,
          environment: issue.metadata?.environment || null,
          release: issue.metadata?.release || null
        };
      });

    return {
      issues: issues,
      lastUpdated: new Date().toISOString(),
      totalIssues: rawData.length,
      statusCode: 200
    };
  },

  /**
   * Format timestamp to human-readable relative time
   */
  formatTimeAgo: function (timestamp) {
    if (!timestamp) return "unknown";

    const now = Date.now();
    const past = new Date(timestamp).getTime();
    const seconds = Math.floor((now - past) / 1000);

    if (seconds < 60) return "just now";
    if (seconds < 120) return "1 minute ago";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 7200) return "1 hour ago";
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 172800) return "1 day ago";
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)} days ago`;
    if (seconds < 5184000) return "1 month ago";
    return `${Math.floor(seconds / 2592000)} months ago`;
  },

  /**
   * Truncate text to specified length
   */
  truncateText: function (text, length) {
    if (!text) return "";
    if (text.length <= length) return text;
    return text.substring(0, length - 3) + "...";
  },

  /**
   * Calculate percentage of total
   */
  calculatePercentage: function (count, total) {
    if (!total || total === 0) return 0;
    return parseFloat(((count / total) * 100).toFixed(1));
  },

  /**
   * Handle errors and send to frontend
   */
  handleError: function (errorMessage) {
    // If we have cached data, send it along with the error
    if (this.lastSuccessfulData) {
      this.sendSocketNotification("SENTRY_UPDATE", {
        ...this.lastSuccessfulData,
        error: errorMessage
      });
    } else {
      this.sendSocketNotification("SENTRY_ERROR", {
        error: errorMessage,
        lastUpdated: new Date().toISOString()
      });
    }
  },

  /**
   * Schedule retry after delay
   */
  scheduleRetry: function (delay) {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
    }

    this.retryTimeout = setTimeout(() => {
      console.log("[MMM-Sentry-Monitoring] Retrying fetch...");
      this.fetchSentryIssues();
    }, delay);
  }
});
