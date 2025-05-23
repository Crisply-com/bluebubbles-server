import { Server } from "@server";
import { HTTPError } from "@server/api/http/api/v1/responses/errors";
import { Loggable } from "@server/lib/logging/Loggable";
import axios from "axios";
import { app, BrowserWindow } from "electron";
import fs from "fs";
import http from "http";
import KoaApp from "koa";
import path from "path";

const TOKEN_PATH = path.join(app.getPath("userData"), "hubspot_tokens.json");

export class HubspotOauthService extends Loggable {
    tag = "HubspotOauthService";
    koaApp: KoaApp;
    httpServer: http.Server;
    port: number = 8642;
    running: boolean = false;

    tokens: { access_token: string; refresh_token: string; expires_in: number } | null = null;

    private get clientId(): string {
        // Try environment variable first, then fall back to config (for future UI support)
        return process.env.HUBSPOT_CLIENT_ID || (Server().repo.getConfig("hubspot_client_id") as string) || "";
    }

    private get clientSecret(): string {
        // Try environment variable first, then fall back to config (for future UI support)
        return process.env.HUBSPOT_CLIENT_SECRET || (Server().repo.getConfig("hubspot_client_secret") as string) || "";
    }

    private redirectUri = `http://localhost:${this.port}/hubspot/callback`;
    private scopes = [
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "settings.users.read",
        "oauth",
        "timeline"
    ];
    private authWindow: BrowserWindow | null = null;

    constructor() {
        super();
        this.koaApp = new KoaApp();
        this.configureRoutes();
        this.httpServer = http.createServer(this.koaApp.callback());
        this.loadTokensSync();
    }

    getAuthUrl(): string {
        if (!this.clientId) {
            throw new Error("HubSpot Client ID not configured. Set HUBSPOT_CLIENT_ID environment variable.");
        }

        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            scope: this.scopes.join(" "),
            response_type: "code"
        });
        return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
    }

    async start() {
        if (this.running) {
            this.log.info("HubSpot OAuth service already running.");
            if (!this.authWindow) {
                // If server is up but window was closed, re-open it
                const authUrl = this.getAuthUrl();
                await this.openBrowser(authUrl);
            }
            return;
        }

        this.log.info("Starting HubSpot OAuth service...");
        this.httpServer.listen(this.port, () => {
            this.log.info(`OAuth server listening on port ${this.port}`);
        });

        this.running = true;

        const authUrl = this.getAuthUrl();
        await this.openBrowser(authUrl);
    }

    async stop(): Promise<void> {
        this.log.info("Stopping HubSpot OAuth service...");
        this.running = false;

        return new Promise((resolve, reject) => {
            this.httpServer.close(err => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    configureRoutes() {
        this.koaApp.use(async ctx => {
            if (ctx.path === "/hubspot/callback" && ctx.query.code) {
                const code = ctx.query.code as string;

                if (!this.clientId || !this.clientSecret) {
                    this.log.error("HubSpot credentials not configured");
                    ctx.body = `HubSpot credentials not configured.
                        Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET environment variables.`;
                    ctx.status = 500;
                    return;
                }

                try {
                    const tokenRes = await axios.post(
                        `https://api.hubapi.com/oauth/v1/token`,
                        new URLSearchParams({
                            grant_type: "authorization_code",
                            client_id: this.clientId,
                            client_secret: this.clientSecret,
                            redirect_uri: this.redirectUri,
                            code
                        }),
                        {
                            headers: { "Content-Type": "application/x-www-form-urlencoded" }
                        }
                    );

                    this.saveTokens(tokenRes.data);

                    // Initialize API service after successful OAuth
                    if (!Server().hubspotApiService) {
                        const { HubspotApiService } = await import("../hubspotApiService");
                        Server().hubspotApiService = new HubspotApiService();
                        Server().log("HubSpot API Service initialized after successful OAuth");
                    }

                    Server().emitToUI("hubspot-auth-success", true);

                    if (this.authWindow) {
                        this.authWindow.close();
                        this.authWindow = null;
                    }

                    ctx.body = "HubSpot Auth successful! You may close this window.";
                    ctx.status = 200;
                } catch (err: HTTPError | any) {
                    this.log.error(`OAuth exchange failed: ${err.message}`);
                    ctx.body = "OAuth token exchange failed.";
                    ctx.status = 500;
                }
                await this.stop();
            } else {
                ctx.body = "Invalid route.";
                ctx.status = 404;
            }
        });
    }

    async openBrowser(url: string): Promise<void> {
        return new Promise(resolve => {
            this.authWindow = new BrowserWindow({
                width: 800,
                height: 600,
                webPreferences: { nodeIntegration: true }
            });

            this.authWindow.loadURL(url);

            this.authWindow.on("closed", () => {
                this.authWindow = null;
                resolve();
            });
        });
    }

    saveTokens(tokens: any) {
        const dir = path.dirname(TOKEN_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        this.tokens = tokens;
        this.log.info(`HubSpot tokens saved to: ${TOKEN_PATH}`);
    }

    loadTokensSync(): any {
        this.log.info(`Checking for tokens at: ${TOKEN_PATH}`);
        if (fs.existsSync(TOKEN_PATH)) {
            try {
                this.tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
                this.log.info(
                    `Loaded HubSpot tokens from: ${TOKEN_PATH}, access_token present: ${!!this.tokens?.access_token}`
                );
            } catch (error) {
                this.log.error(`Failed to parse token file: ${error}`);
                this.tokens = null;
            }
        } else {
            this.log.info(`No token file found at: ${TOKEN_PATH}`);
        }
        return this.tokens;
    }

    getTokens() {
        return this.tokens;
    }

    disconnect() {
        this.log.info("Disconnecting HubSpot OAuth...");
        this.tokens = null;

        // Remove the token file
        if (fs.existsSync(TOKEN_PATH)) {
            fs.unlinkSync(TOKEN_PATH);
            this.log.info(`Removed HubSpot tokens file: ${TOKEN_PATH}`);
        }

        // Clear the authenticated user cache from API service
        if (Server().hubspotApiService) {
            Server().hubspotApiService.clearAuthenticatedUserCache();
        }

        // Clear the API service from the server
        Server().hubspotApiService = null;
        Server().log("HubSpot API Service cleared after disconnect");
    }

    hasValidTokens(): boolean {
        if (!this.tokens?.access_token) {
            this.log.debug("No access token available");
            return false;
        }

        // Check if token has expiration info and if it's expired
        if (this.tokens.expires_in) {
            const tokenPath = TOKEN_PATH;
            if (fs.existsSync(tokenPath)) {
                try {
                    const stats = fs.statSync(tokenPath);
                    const tokenCreatedTime = stats.mtime.getTime();
                    const currentTime = Date.now();
                    const tokenAgeSeconds = (currentTime - tokenCreatedTime) / 1000;

                    if (tokenAgeSeconds > this.tokens.expires_in) {
                        this.log.info(
                            `Token expired: age=${Math.round(tokenAgeSeconds)}s, expires_in=${this.tokens.expires_in}s`
                        );
                        return false;
                    }
                } catch (error) {
                    this.log.error(`Error checking token expiration: ${error}`);
                }
            }
        }

        this.log.debug("Token is valid");
        return true;
    }

    async refreshTokenIfNeeded(): Promise<boolean> {
        if (!this.tokens?.refresh_token) {
            this.log.info("No refresh token available");
            return false;
        }

        // Check if token needs refresh (if it expires in less than 5 minutes)
        if (this.tokens.expires_in) {
            const tokenPath = TOKEN_PATH;
            if (fs.existsSync(tokenPath)) {
                try {
                    const stats = fs.statSync(tokenPath);
                    const tokenCreatedTime = stats.mtime.getTime();
                    const currentTime = Date.now();
                    const tokenAgeSeconds = (currentTime - tokenCreatedTime) / 1000;
                    const timeUntilExpiry = this.tokens.expires_in - tokenAgeSeconds;

                    // If token expires in less than 5 minutes, refresh it
                    if (timeUntilExpiry < 300) {
                        this.log.info(`Token expires soon (${Math.round(timeUntilExpiry)}s), refreshing...`);
                        return await this.refreshToken();
                    }
                } catch (error) {
                    this.log.error(`Error checking token for refresh: ${error}`);
                }
            }
        }

        return true;
    }

    async refreshToken(): Promise<boolean> {
        if (!this.tokens?.refresh_token) {
            this.log.error("No refresh token available for refresh");
            return false;
        }

        if (!this.clientId || !this.clientSecret) {
            this.log.error("HubSpot credentials not configured for token refresh");
            return false;
        }

        try {
            const tokenRes = await axios.post(
                `https://api.hubapi.com/oauth/v1/token`,
                new URLSearchParams({
                    grant_type: "refresh_token",
                    client_id: this.clientId,
                    client_secret: this.clientSecret,
                    refresh_token: this.tokens.refresh_token
                }),
                {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" }
                }
            );

            this.saveTokens(tokenRes.data);

            // Clear authenticated user cache after token refresh
            if (Server().hubspotApiService) {
                Server().hubspotApiService.clearAuthenticatedUserCache();
            }

            this.log.info("Successfully refreshed HubSpot tokens");
            return true;
        } catch (error: any) {
            this.log.error(`Failed to refresh token: ${error?.response?.data?.message ?? error.message}`);
            // If refresh fails, clear the tokens
            this.tokens = null;
            if (fs.existsSync(TOKEN_PATH)) {
                fs.unlinkSync(TOKEN_PATH);
            }
            return false;
        }
    }
}
