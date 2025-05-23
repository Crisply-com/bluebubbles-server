import { Server } from "@server";
import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Success } from "../responses/success";

export class HubspotOauthRouter {
    static async startOAuth(_: RouterContext, __: Next): Promise<void> {
        await Server().hubspotOauthService.start();
    }

    static async getTokens(ctx: RouterContext, _: Next): Promise<void> {
        const tokens = Server().hubspotOauthService.getTokens();
        return new Success(ctx, {
            message: "Retrieved stored HubSpot tokens",
            data: tokens
        }).send();
    }

    static async disconnect(ctx: RouterContext, _: Next): Promise<void> {
        Server().hubspotOauthService.disconnect();
        return new Success(ctx, {
            message: "HubSpot disconnected successfully"
        }).send();
    }
}
