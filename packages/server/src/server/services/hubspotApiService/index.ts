import { Server } from "@server";
import { Message } from "@server/databases/imessage/entity/Message";
import { Loggable } from "@server/lib/logging/Loggable";
import axios from "axios";

export class HubspotApiService extends Loggable {
    tag = "HubspotApiService";

    private readonly baseUrl = "https://api.hubapi.com";

    private get contactEventTemplateId(): string {
        return process.env.HUBSPOT_CONTACT_EVENT_TEMPLATE_ID;
    }

    private get companyEventTemplateId(): string {
        return process.env.HUBSPOT_COMPANY_EVENT_TEMPLATE_ID;
    }

    private authenticatedUser: { displayName?: string; email?: string } | null = null;

    private get accessToken(): string {
        const token = Server().hubspotOauthService.getTokens()?.access_token;
        if (!token) throw new Error("HubSpot access token not found.");
        return token;
    }

    private get authHeaders() {
        return {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json"
        };
    }

    async getAuthenticatedUser(): Promise<{ displayName?: string; email?: string }> {
        if (this.authenticatedUser) return this.authenticatedUser;

        try {
            const res = await axios.get(`${this.baseUrl}/oauth/v1/access-tokens/${this.accessToken}`, {
                headers: this.authHeaders
            });

            const userEmail = res.data?.user;
            const userId = res.data?.user_id;

            if (!userEmail) {
                this.log.warn("Could not retrieve user email from token info");
                this.authenticatedUser = { displayName: "Agent" };
                return this.authenticatedUser;
            }

            // Try to get user details using the settings/v3/users API
            if (userId) {
                try {
                    const userRes = await axios.get(`${this.baseUrl}/settings/v3/users/${userId}`, {
                        headers: this.authHeaders
                    });

                    const user = userRes.data;
                    if (user) {
                        const firstName = user.firstName || "";
                        const lastName = user.lastName || "";
                        const displayName = `${firstName} ${lastName}`.trim();

                        this.authenticatedUser = {
                            displayName: displayName || userEmail,
                            email: userEmail
                        };

                        this.log.info(`Authenticated HubSpot user: ${this.authenticatedUser.displayName}`);
                        return this.authenticatedUser;
                    }
                } catch (error: any) {
                    this.log.debug(
                        `Could not fetch user details, using email as display name: ${
                            error?.response?.data?.message ?? error.message
                        }`
                    );
                }
            }

            // Fallback to email as display name
            this.authenticatedUser = {
                displayName: userEmail,
                email: userEmail
            };

            this.log.info(`Authenticated HubSpot user: ${this.authenticatedUser.displayName}`);
            return this.authenticatedUser;
        } catch (error: any) {
            this.log.error(`Failed to get authenticated user info: ${error?.response?.data?.message ?? error.message}`);
            this.authenticatedUser = { displayName: "Agent" };
            return this.authenticatedUser;
        }
    }

    async getUserDisplayName(): Promise<string> {
        const user = await this.getAuthenticatedUser();
        return user.displayName || user.email || "Agent";
    }

    clearAuthenticatedUserCache(): void {
        this.authenticatedUser = null;
        this.log.debug("Cleared authenticated user cache");
    }

    async getSenderName(isFromMe: boolean, participantId?: string): Promise<string> {
        if (isFromMe) {
            try {
                return await this.getUserDisplayName();
            } catch (error) {
                this.log.warn(`Failed to get HubSpot user display name: ${error}`);
                return "Agent";
            }
        } else {
            return participantId || "Unknown";
        }
    }

    async handleNewMessage(message: Message): Promise<void> {
        try {
            // Extract message data
            const address = message?.chats?.[0]?.chatIdentifier;
            const text = message?.text;
            const isInbound = !message?.isFromMe;
            const participantId = message?.chats?.[0]?.participants?.[0]?.id;

            // Get sender name
            const senderName = await this.getSenderName(message?.isFromMe, participantId);

            // Log the message details
            this.log.debug(
                `Processing HubSpot message event: ${JSON.stringify({
                    address,
                    text: text?.substring(0, 100) + (text?.length > 100 ? "..." : ""), // Truncate for logging
                    sender: senderName,
                    isInbound
                })}`
            );

            // Post to HubSpot if we have the required data
            if (address && text) {
                await this.postCombinedContactAndCompanyEvent(address, text, senderName, isInbound);
            } else {
                this.log.warn(
                    `Missing required data for HubSpot event: ${JSON.stringify({ address: !!address, text: !!text })}`
                );
            }
        } catch (error: any) {
            this.log.error(`Failed to handle HubSpot message event: ${error?.message ?? error}`);
        }
    }

    async lookupContactByPhone(phone: string): Promise<string | null> {
        const url = `${this.baseUrl}/crm/v3/objects/contacts/search`;
        const payload = {
            filterGroups: [
                {
                    filters: [{ propertyName: "phone", operator: "EQ", value: phone }]
                }
            ],
            properties: ["hs_object_id", "email", "phone"],
            limit: 1
        };

        try {
            const res = await axios.post(url, payload, { headers: this.authHeaders });
            return res.data.results?.[0]?.id ?? null;
        } catch (error: any) {
            this.log.error(`HubSpot contact lookup failed: ${error?.response?.data?.message ?? error.message}`);
            return null;
        }
    }

    async lookupContactByEmail(email: string): Promise<string | null> {
        const url = `${this.baseUrl}/crm/v3/objects/contacts/search`;
        const payload = {
            filterGroups: [
                {
                    filters: [{ propertyName: "email", operator: "EQ", value: email }]
                }
            ],
            properties: ["hs_object_id", "email"],
            limit: 1
        };

        try {
            const res = await axios.post(url, payload, { headers: this.authHeaders });
            return res.data.results?.[0]?.id ?? null;
        } catch (error: any) {
            this.log.error(`HubSpot email lookup failed: ${error?.response?.data?.message ?? error.message}`);
            return null;
        }
    }

    async getContactDetails(contactId: string): Promise<{ firstname?: string; lastname?: string; email?: string }> {
        const url = `${this.baseUrl}/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email`;

        try {
            const res = await axios.get(url, { headers: this.authHeaders });
            return res.data?.properties ?? {};
        } catch (error: any) {
            this.log.error(`Failed to fetch contact details: ${error?.response?.data?.message ?? error.message}`);
            return {};
        }
    }

    async getAssociatedCompanyId(contactId: string): Promise<string | null> {
        const url = `${this.baseUrl}/crm/v4/objects/contacts/${contactId}/associations/companies`;

        try {
            const res = await axios.get(url, { headers: this.authHeaders });
            return res.data?.results?.[0]?.toObjectId?.toString() ?? null;
        } catch (error: any) {
            this.log.error(`Failed to fetch company association: ${error?.response?.data?.message ?? error.message}`);
            return null;
        }
    }

    async postTimelineEventForContact(data: {
        contactId?: string;
        email?: string;
        text: string;
        sender: string;
        isInbound: boolean;
        timestamp?: string | number;
    }): Promise<string | null> {
        const payload: any = {
            eventTemplateId: this.contactEventTemplateId,
            tokens: {
                message: data.text,
                senderLabel: data.sender,
                isInbound: data.isInbound.toString(),
                messageDirection: data.isInbound
                    ? `**📨 Received from ${data.sender}:**`
                    : `**📤 Sent by ${data.sender}:**`
            },
            timestamp: data.timestamp ?? Date.now()
        };

        if (data.contactId) payload.objectId = data.contactId;
        else if (data.email) payload.email = data.email;
        else throw new Error("Must provide either contactId or email to post contact timeline event.");

        try {
            const res = await axios.post(`${this.baseUrl}/integrators/timeline/v3/events`, payload, {
                headers: this.authHeaders
            });
            this.log.info("Posted timeline event to contact.");
            return res.data?.objectId ?? data.contactId ?? null;
        } catch (error: any) {
            this.log.error(`Error posting contact timeline event: ${error?.response?.data?.message ?? error.message}`);
            return null;
        }
    }

    async postTimelineEventForCompany(data: {
        companyId: string;
        contactName?: string;
        contactEmail?: string;
        contactId?: string;
        text: string;
        sender: string;
        isInbound: boolean;
        timestamp?: string | number;
    }): Promise<boolean> {
        const snippet = data.text.length > 60 ? `${data.text.slice(0, 57)}...` : data.text;

        // Get portal ID from OAuth token
        let portalId = "unknown";
        try {
            const tokenRes = await axios.get(`${this.baseUrl}/oauth/v1/access-tokens/${this.accessToken}`, {
                headers: this.authHeaders
            });
            portalId = tokenRes.data?.hub_id?.toString() || "unknown";
        } catch (error) {
            this.log.warn("Could not fetch portal ID for company event");
        }

        const payload = {
            eventTemplateId: this.companyEventTemplateId,
            objectId: data.companyId,
            tokens: {
                message: data.text,
                senderLabel: data.sender,
                isInbound: data.isInbound.toString(),
                headerMessageSnippet: snippet,
                contactDisplayName: data.contactName ?? "Unknown",
                contactLinkEmail: data.contactEmail ?? "",
                contactHsId: data.contactId ?? "",
                appProvidedPortalId: portalId,
                headerDirection: data.isInbound
                    ? `iMessage from **${data.contactName ?? "Unknown"}**`
                    : `iMessage to **${data.contactName ?? "Unknown"}** (by ${data.sender})`,
                detailDirection: data.isInbound
                    ? `Incoming Message (from ${data.contactName ?? "Unknown"})`
                    : `Outgoing Message (to ${data.contactName ?? "Unknown"})`
            },
            timestamp: data.timestamp ?? Date.now()
        };

        try {
            await axios.post(`${this.baseUrl}/integrators/timeline/v3/events`, payload, {
                headers: this.authHeaders
            });
            this.log.info("Posted timeline event to company.");
            return true;
        } catch (error: any) {
            this.log.error(`Error posting company timeline event: ${error?.response?.data?.message ?? error.message}`);
            return false;
        }
    }

    async postCombinedContactAndCompanyEvent(
        address: string,
        text: string,
        sender: string,
        isInbound: boolean
    ): Promise<void> {
        let contactId: string | null = null;
        let contactEmail: string | undefined;

        if (/^\+?[0-9\s\-()]+$/.test(address)) {
            contactId = await this.lookupContactByPhone(address);
        }

        if (!contactId && address.includes("@")) {
            contactEmail = address;
            contactId = await this.lookupContactByEmail(address);
        }

        if (!contactId && !contactEmail) {
            this.log.warn(`Could not resolve contact for address: ${address}`);
            return;
        }

        const finalContactId = contactId;
        const contactObjId = await this.postTimelineEventForContact({
            contactId,
            email: contactEmail,
            text,
            sender,
            isInbound
        });

        if (!contactObjId) return;

        const companyId = await this.getAssociatedCompanyId(contactObjId);
        if (!companyId) {
            this.log.info("No company associated. Skipping company timeline event.");
            return;
        }

        const contactDetails = await this.getContactDetails(contactObjId);
        const contactName =
            contactDetails.firstname && contactDetails.lastname
                ? `${contactDetails.firstname} ${contactDetails.lastname}`
                : contactDetails.firstname ?? contactDetails.email ?? "Unknown";

        await this.postTimelineEventForCompany({
            companyId,
            contactId: contactObjId,
            contactEmail: contactDetails.email,
            contactName,
            text,
            sender,
            isInbound
        });
    }
}
