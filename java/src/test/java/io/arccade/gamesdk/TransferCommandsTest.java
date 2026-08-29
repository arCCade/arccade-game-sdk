package io.arccade.gamesdk;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import io.arccade.gamesdk.TransferCommands.Recipient;
import io.arccade.gamesdk.TransferCommands.Transfer;
import io.arccade.gamesdk.TransferCommands.TransferOptions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** The narrowest endpoint in the SDK, and the reasons it is narrow. */
class TransferCommandsTest {

    private static final InstrumentId COIN = new InstrumentId("dso-party", "Amulet");

    @Test
    @DisplayName("golden vector: a single-recipient transfer document and its digest")
    void transferDocumentGoldenVector() {
        Transfer t = new Transfer("x-1", "venue-party", "reward",
                List.of(new Recipient("player-party", "5.0", COIN)), Map.of());
        assertEquals("arccade-game-sdk:transfer:1:transferId=x-1|sender=venue-party|reason=reward"
                        + "|to=player-party:5.0:dso-party/Amulet",
                TransferCommands.transferDocument(t));
        assertEquals("28a551239227d58f20a40560e1e11344d3f48e44fbb8894bf2b0c0690e63d437",
                TransferCommands.transferDigest(t));
    }

    @Test
    @DisplayName("batch order is PRESERVED while meta is sorted")
    void batchOrderIsPreserved() {
        // The recipient order is the transaction the ledger will execute;
        // reordering it here would make the published document describe a
        // different transaction from the one submitted.
        Transfer t = new Transfer("x-2", "venue-party", "payout",
                List.of(new Recipient("p2", "2.0", COIN), new Recipient("p1", "1.0", COIN)),
                Map.of());
        assertEquals("arccade-game-sdk:transfer:1:transferId=x-2|sender=venue-party|reason=payout"
                        + "|to=p2:2.0:dso-party/Amulet|to=p1:1.0:dso-party/Amulet",
                TransferCommands.transferDocument(t));

        Transfer meta = new Transfer("x-3", "venue-party", "refund",
                List.of(new Recipient("p1", "1.0", COIN)), Map.of("z", "1", "a", "2"));
        assertEquals("arccade-game-sdk:transfer:1:transferId=x-3|sender=venue-party|reason=refund"
                        + "|to=p1:1.0:dso-party/Amulet|meta.a=2|meta.z=1",
                TransferCommands.transferDocument(meta));
    }

    @Test
    @DisplayName("a pipe in meta is refused")
    void pipeInMetaIsRefused() {
        assertThrows(IllegalArgumentException.class, () -> TransferCommands.transferDocument(
                new Transfer("x-4", "venue-party", "p2p",
                        List.of(new Recipient("p1", "1.0", COIN)),
                        Map.of("memo", "for the|sword"))));
    }

    @Test
    @DisplayName("a batch is one transaction and the sender signs it")
    void batchIsOneTransaction() {
        Json built = TransferCommands.buildTransferCommands(new TransferOptions(
                "amuletpkg", "venue-party", "venue-party",
                List.of(new Recipient("player-1", "5.0", COIN),
                        new Recipient("player-2", "3.0", COIN)),
                List.of("amulet-0001"), "rules-0001", "round-0001", "dso-party",
                "x-0001", "reward", "transfer-x-0001", Map.of()));

        assertEquals(1, built.path("commands").size());
        Json outputs = built.path("commands").path(0).path("ExerciseCommand")
                .path("choiceArgument").path("transfer").path("outputs");
        assertEquals(2, outputs.size());
        assertEquals("player-1", outputs.path(0).path("receiver").asText());
        // sender and provider are one party here, and must not be listed twice.
        assertEquals(1, built.path("actAs").size());
        assertEquals("3b53d8bb0eb0916841b7102b87dbc10ac08277e3b1f434fa5973351ac78285da",
                built.path("digest").asText());
    }

    @Test
    @DisplayName("self-transfer, a repeated recipient, an empty batch, a zero amount and an unknown reason are all refused")
    void theFourRefusals() {
        assertThrows(IllegalArgumentException.class, () -> build("venue-party", "reward",
                List.of(new Recipient("venue-party", "5.0", COIN))));
        assertThrows(IllegalArgumentException.class, () -> build("venue-party", "reward",
                List.of(new Recipient("p1", "5.0", COIN), new Recipient("p1", "3.0", COIN))));
        assertThrows(IllegalArgumentException.class, () -> build("venue-party", "reward",
                List.of()));
        assertThrows(IllegalArgumentException.class, () -> build("venue-party", "reward",
                List.of(new Recipient("p1", "0", COIN))));
        assertThrows(IllegalArgumentException.class, () -> build("venue-party", "airdrop",
                List.of(new Recipient("p1", "5.0", COIN))));
    }

    private static Json build(String sender, String reason, List<Recipient> recipients) {
        return TransferCommands.buildTransferCommands(new TransferOptions("amuletpkg", sender,
                sender, recipients, List.of("amulet-0001"), "rules-0001", "round-0001",
                "dso-party", "x-0001", reason, null, Map.of()));
    }
}
