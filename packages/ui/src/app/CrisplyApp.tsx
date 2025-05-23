/* eslint-disable react/react-in-jsx-scope */
/* eslint-disable max-len */
/* eslint-disable quotes */
import { Box, Button, ChakraProvider, extendTheme, Heading, Text, useToast, VStack } from "@chakra-ui/react";
import { ipcRenderer } from "electron";
import { useEffect, useState } from "react";

// Define a custom theme (optional, for styling)
const theme = extendTheme({
    config: {
        initialColorMode: "dark",
        useSystemColorMode: false
    },
    styles: {
        global: (props: { colorMode: string }) => ({
            body: {
                bg: props.colorMode === "dark" ? "gray.800" : "gray.50",
                color: props.colorMode === "dark" ? "whiteAlpha.900" : "gray.800",
                fontFamily: "Inter, sans-serif",
                lineHeight: "base"
            }
        })
    },
    fonts: {
        heading: `'Inter', sans-serif`,
        body: `'Inter', sans-serif`
    },
    components: {
        Button: {
            baseStyle: {
                fontWeight: "semibold",
                borderRadius: "md"
            }
        },
        Heading: {
            baseStyle: {
                fontWeight: "bold"
            }
        }
    }
});

function CrisplyApp() {
    const toast = useToast();
    const [isConnected, setIsConnected] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    // Check for existing tokens on load
    useEffect(() => {
        const loadingStartTime = Date.now();

        const finalizeLoading = async (isConnected: boolean) => {
            // Check if minimum loading time has elapsed
            const elapsedTime = Date.now() - loadingStartTime;
            const minLoadingTime = 800; // 800ms minimum

            const completeLoading = () => {
                setIsLoading(false);
                setIsConnected(isConnected);

                if (isConnected) {
                    toast({
                        title: "HubSpot Already Connected",
                        description: "Your account is already connected to HubSpot.",
                        status: "success",
                        duration: 5000,
                        isClosable: true,
                        position: "top"
                    });
                }
            };

            if (elapsedTime >= minLoadingTime) {
                // Enough time has passed, hide loading immediately
                completeLoading();
            } else {
                // Wait for remaining time, then hide loading
                const remainingTime = minLoadingTime - elapsedTime;
                setTimeout(completeLoading, remainingTime);
            }
        };

        const checkIfConnected = async (fromServerReady = false) => {
            try {
                const isConnected = await ipcRenderer.invoke("check-hubspot-connection");

                // Only hide loading if:
                // 1. We got server-ready event (server is definitely ready), OR
                // 2. We're connected (tokens are valid)
                if (fromServerReady || isConnected) {
                    await finalizeLoading(isConnected);
                }
                // If not connected and no server-ready event, keep loading visible
            } catch (err) {
                console.error("Failed to check HubSpot connection:", err);
                // Only hide loading if this was from server-ready event
                if (fromServerReady) {
                    await finalizeLoading(false);
                }
            }
        };

        // Listen for server ready event
        const handleServerReady = () => {
            checkIfConnected(true);
        };

        // Check immediately in case server is already ready
        checkIfConnected(false);

        // Listen for server ready event
        ipcRenderer.on("server-ready", handleServerReady);

        return () => {
            ipcRenderer.removeListener("server-ready", handleServerReady);
        };
    }, [toast]);

    // Listen for successful OAuth signal from backend
    useEffect(() => {
        const handleHubspotAuth = () => {
            setIsLoading(false);
            setIsConnected(true);
            toast({
                title: "HubSpot Connected",
                description: "Your HubSpot account has been successfully connected!",
                status: "success",
                duration: 6000,
                isClosable: true,
                position: "top"
            });
        };

        const handleHubspotDisconnect = () => {
            setIsLoading(false);
            setIsConnected(false);
            toast({
                title: "HubSpot Disconnected",
                description: "Your HubSpot account has been disconnected.",
                status: "info",
                duration: 5000,
                isClosable: true,
                position: "top"
            });
        };

        ipcRenderer.on("hubspot-auth-success", handleHubspotAuth);
        ipcRenderer.on("hubspot-disconnected", handleHubspotDisconnect);

        return () => {
            ipcRenderer.removeListener("hubspot-auth-success", handleHubspotAuth);
            ipcRenderer.removeListener("hubspot-disconnected", handleHubspotDisconnect);
        };
    }, [toast]);

    const handleConnectHubspot = async () => {
        try {
            // await fetch("/api/hubspot/start-oauth");
            ipcRenderer.invoke("start-hubspot-oauth");
            toast({
                title: "Opening HubSpot...",
                description: "Please complete authentication in the new window.",
                status: "info",
                duration: 7000,
                isClosable: true,
                position: "top"
            });
        } catch (err) {
            toast({
                title: "Error",
                description: "Failed to start HubSpot OAuth flow.",
                status: "error",
                duration: 6000,
                isClosable: true,
                position: "top"
            });
            console.error("Failed to start OAuth:", err);
        }
    };

    const handleDisconnectHubspot = async () => {
        try {
            await ipcRenderer.invoke("disconnect-hubspot");
            // toast({
            //     title: "Disconnecting...",
            //     description: "Disconnecting from HubSpot.",
            //     status: "info",
            //     duration: 3000,
            //     isClosable: true,
            //     position: "top"
            // });
        } catch (err) {
            toast({
                title: "Error",
                description: "Failed to disconnect from HubSpot.",
                status: "error",
                duration: 5000,
                isClosable: true,
                position: "top"
            });
            console.error("Failed to disconnect:", err);
        }
    };

    return (
        <ChakraProvider theme={theme}>
            <Box
                textAlign="center"
                fontSize="xl"
                minH="100vh"
                display="flex"
                alignItems="center"
                justifyContent="center"
                p={4}
            >
                <VStack
                    spacing={8}
                    bg={theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800" ? "gray.700" : "white"}
                    p={{ base: 6, md: 10 }}
                    borderRadius="xl"
                    boxShadow="2xl"
                    maxW="lg"
                    w="full"
                    position="relative"
                >
                    {isLoading ? (
                        <>
                            <Heading
                                as="h1"
                                size="md"
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "cyan.300"
                                        : "blue.600"
                                }
                            >
                                Crisply{" "}
                                <Box
                                    as="span"
                                    color={
                                        theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                            ? "orange.300"
                                            : "orange.500"
                                    }
                                >
                                    x
                                </Box>{" "}
                                HubSpot iMessage Client
                            </Heading>
                            <Text
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "gray.300"
                                        : "gray.600"
                                }
                                mb={4}
                            >
                                Checking HubSpot connection status...
                            </Text>
                            <Box
                                width="40px"
                                height="40px"
                                border="4px solid"
                                borderColor={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "gray.600"
                                        : "gray.200"
                                }
                                borderTopColor="orange.500"
                                borderRadius="50%"
                                animation="spin 1s linear infinite"
                                sx={{
                                    "@keyframes spin": {
                                        "0%": { transform: "rotate(0deg)" },
                                        "100%": { transform: "rotate(360deg)" }
                                    }
                                }}
                            />
                        </>
                    ) : isConnected ? (
                        <>
                            <Box position="absolute" top={4} right={4}>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    colorScheme="red"
                                    color="red.400"
                                    borderColor="red.400"
                                    _hover={{ bg: "red.50", color: "red.600", borderColor: "red.600" }}
                                    onClick={handleDisconnectHubspot}
                                >
                                    Disconnect
                                </Button>
                            </Box>
                            <Heading
                                as="h1"
                                size="lg"
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "green.300"
                                        : "green.600"
                                }
                                textAlign="center"
                                mt={8}
                            >
                                ✅ Connected to HubSpot
                            </Heading>
                            <Text
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "gray.300"
                                        : "gray.600"
                                }
                                fontSize="md"
                                textAlign="center"
                                lineHeight="tall"
                            >
                                Your Hubspot Account is connected to Crisply iMessage Client.
                            </Text>
                            <Text
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "gray.400"
                                        : "gray.500"
                                }
                                fontSize="sm"
                                textAlign="center"
                                lineHeight="tall"
                            >
                                Please keep this program running to sync new iMessages to Hubspot.
                            </Text>
                        </>
                    ) : (
                        <>
                            <Heading
                                as="h1"
                                size="md"
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "cyan.300"
                                        : "blue.600"
                                }
                            >
                                Crisply{" "}
                                <Box
                                    as="span"
                                    color={
                                        theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                            ? "orange.300"
                                            : "orange.500"
                                    }
                                >
                                    x
                                </Box>{" "}
                                HubSpot iMessage Client
                            </Heading>
                            <Text
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "gray.300"
                                        : "gray.600"
                                }
                            >
                                Connect your HubSpot account to Crisply to sync messages and activities.
                            </Text>
                            <Button
                                colorScheme="orange"
                                bg="orange.500"
                                color="white"
                                _hover={{ bg: "orange.600", transform: "translateY(-2px)", boxShadow: "lg" }}
                                _active={{ bg: "orange.700", transform: "translateY(0)", boxShadow: "md" }}
                                size="lg"
                                px={8}
                                py={6}
                                onClick={handleConnectHubspot}
                                boxShadow="md"
                                transition="all 0.2s ease-in-out"
                            >
                                Connect HubSpot
                            </Button>
                            <Text
                                fontSize="sm"
                                color={
                                    theme.styles.global({ colorMode: "dark" }).body.bg === "gray.800"
                                        ? "gray.400"
                                        : "gray.500"
                                }
                                pt={2}
                            >
                                You will be redirected to HubSpot to authorize the connection.
                            </Text>
                        </>
                    )}
                </VStack>
            </Box>
        </ChakraProvider>
    );
}

export default CrisplyApp;
